import { run } from "./index.js"
import { runCi } from "./kody2-cli.js"

interface ParsedArgs {
  command: "run" | "ci" | "help" | "version"
  issueNumber?: number
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  dryRun?: boolean
  errors: string[]
  ciArgv?: string[]
}

const HELP_TEXT = `kody2 — single-session autonomous engineer

Usage:
  kody2 run --issue <N> [--cwd <path>] [--verbose|--quiet] [--dry-run]
  kody2 ci  --issue <N> [preflight flags — see: kody2 ci --help]
  kody2 help
  kody2 version

Commands:
  run     Run the pipeline directly (assumes deps + LiteLLM already present).
  ci      Full preflight (unpack secrets, install deps, install LiteLLM, git
          identity) then invoke run. Intended as the single command a minimal
          GitHub Actions workflow calls.

Exit codes:
  0  success (PR opened, verify passed)
  1  agent reported FAILED (draft PR opened)
  2  verify failed (draft PR opened)
  3  no commits to ship
  4  PR creation failed
  5  uncommitted changes on target branch
  99 wrapper crashed
`

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: "help", errors: [] }
  if (argv.length === 0) return result

  const cmd = argv[0]!
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return { ...result, command: "help" }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return { ...result, command: "version" }
  if (cmd === "ci") {
    return { ...result, command: "ci", ciArgv: argv.slice(1) }
  }
  if (cmd !== "run") {
    result.errors.push(`unknown command: ${cmd}`)
    return result
  }

  result.command = "run"
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--issue") {
      const n = parseInt(argv[++i] ?? "", 10)
      if (Number.isNaN(n) || n <= 0) result.errors.push("--issue requires a positive integer")
      else result.issueNumber = n
    } else if (arg === "--cwd") {
      result.cwd = argv[++i]
    } else if (arg === "--verbose") {
      result.verbose = true
    } else if (arg === "--quiet") {
      result.quiet = true
    } else if (arg === "--dry-run") {
      result.dryRun = true
    } else {
      result.errors.push(`unknown arg: ${arg}`)
    }
  }

  if (!result.issueNumber) result.errors.push("--issue <N> is required")
  return result
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)

  if (args.errors.length > 0) {
    for (const e of args.errors) process.stderr.write(`error: ${e}\n`)
    process.stderr.write("\n" + HELP_TEXT)
    return 64
  }
  if (args.command === "help") {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (args.command === "version") {
    process.stdout.write("kody2 0.6.0\n")
    return 0
  }
  if (args.command === "ci") {
    try {
      return await runCi(args.ciArgv ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody2] fatal: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n")
      return 99
    }
  }

  try {
    const result = await run({
      issueNumber: args.issueNumber!,
      cwd: args.cwd,
      verbose: args.verbose,
      quiet: args.quiet,
      dryRun: args.dryRun,
    })
    return result.exitCode
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody2] wrapper crashed: ${msg}\n`)
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n")
    process.stdout.write(`PR_URL=FAILED: wrapper crashed: ${msg}\n`)
    return 99
  }
}
