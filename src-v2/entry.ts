import { loadConfig } from "./config.js"
import { runExecutable } from "./executor.js"
import { runCi } from "./kody2-cli.js"

interface ParsedArgs {
  command: "run" | "fix" | "fix-ci" | "resolve" | "ci" | "help" | "version"
  issueNumber?: number
  prNumber?: number
  feedback?: string
  runId?: string
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  dryRun?: boolean
  errors: string[]
  ciArgv?: string[]
}

const HELP_TEXT = `kody2 — single-session autonomous engineer

Usage:
  kody2 run     --issue <N> [--cwd <path>] [--verbose|--quiet] [--dry-run]
  kody2 ci      --issue <N> [preflight flags — see: kody2 ci --help]
  kody2 fix     --pr    <N> [--feedback "..."] [--cwd <path>] [--verbose|--quiet]
  kody2 fix-ci  --pr    <N> [--run-id <ID>]    [--cwd <path>] [--verbose|--quiet]
  kody2 resolve --pr    <N>                    [--cwd <path>] [--verbose|--quiet]
  kody2 help
  kody2 version

All commands dispatch to the Build executable with a specific mode. The
executable is defined by \`src-v2/executables/build/profile.json\`.

Exit codes:
  0   success (PR opened, verify passed)
  1   agent reported FAILED (draft PR opened)
  2   verify failed (draft PR opened)
  3   no commits to ship
  4   PR creation failed
  5   uncommitted changes on target branch
  64  invalid CLI args
  99  wrapper crashed
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

  if (cmd === "run" || cmd === "fix" || cmd === "fix-ci" || cmd === "resolve") {
    result.command = cmd
    parseCommandArgs(cmd, argv.slice(1), result)
    return result
  }

  result.errors.push(`unknown command: ${cmd}`)
  return result
}

function parseCommandArgs(cmd: ParsedArgs["command"], rest: string[], result: ParsedArgs): void {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--issue") {
      const n = parseInt(rest[++i] ?? "", 10)
      if (Number.isNaN(n) || n <= 0) result.errors.push("--issue requires a positive integer")
      else result.issueNumber = n
    } else if (arg === "--pr") {
      const n = parseInt(rest[++i] ?? "", 10)
      if (Number.isNaN(n) || n <= 0) result.errors.push("--pr requires a positive integer")
      else result.prNumber = n
    } else if (arg === "--feedback") {
      result.feedback = rest[++i]
    } else if (arg === "--run-id") {
      result.runId = rest[++i]
    } else if (arg === "--cwd") {
      result.cwd = rest[++i]
    } else if (arg === "--verbose") result.verbose = true
    else if (arg === "--quiet") result.quiet = true
    else if (arg === "--dry-run") result.dryRun = true
    else result.errors.push(`unknown arg: ${arg}`)
  }

  if (cmd === "run" && !result.issueNumber) result.errors.push("--issue <N> is required for run")
  if (cmd === "fix" && !result.prNumber) result.errors.push("--pr <N> is required for fix")
  if (cmd === "fix-ci" && !result.prNumber) result.errors.push("--pr <N> is required for fix-ci")
  if (cmd === "resolve" && !result.prNumber) result.errors.push("--pr <N> is required for resolve")
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
    process.stdout.write("kody2 0.7.8\n")
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

  // All four pipeline commands (run/fix/fix-ci/resolve) dispatch to the Build executable.
  const cwd = args.cwd ?? process.cwd()
  let config
  try { config = loadConfig(cwd) }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody2] config error: ${msg}\n`)
    process.stdout.write(`PR_URL=FAILED: config error: ${msg}\n`)
    return 99
  }

  const cliArgs: Record<string, unknown> = { mode: args.command }
  if (args.issueNumber !== undefined) cliArgs.issue = args.issueNumber
  if (args.prNumber !== undefined) cliArgs.pr = args.prNumber
  if (args.feedback !== undefined) cliArgs.feedback = args.feedback
  if (args.runId !== undefined) cliArgs.runId = args.runId

  try {
    const result = await runExecutable("build", {
      cliArgs,
      cwd,
      config,
      verbose: args.verbose,
      quiet: args.quiet,
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
