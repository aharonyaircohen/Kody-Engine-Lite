import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { run } from "./index.js"
import { loadConfig, parseProviderModel, needsLitellmProxy } from "./config.js"
import { postIssueComment, truncate } from "./issue.js"

type PackageManager = "pnpm" | "yarn" | "bun" | "npm"

export interface Kody2Args {
  issueNumber?: number
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  skipInstall?: boolean
  skipLitellm?: boolean
  packageManager?: PackageManager
  errors: string[]
}

export const KODY2_HELP = `kody2 — minimal-YAML autonomous engineer

Usage:
  kody2 --issue <N> [--cwd <path>] [--verbose|--quiet]
        [--skip-install] [--skip-litellm] [--package-manager pnpm|yarn|bun|npm]

Options:
  --issue <N>          GitHub issue number to work on (required)
  --cwd <path>         Project directory (default: cwd)
  --verbose            Print full tool output
  --quiet              Print only errors and final PR_URL
  --skip-install       Skip dependency install (pre-warmed runners)
  --skip-litellm       Skip LiteLLM proxy install (Anthropic-direct)
  --package-manager    Override package-manager auto-detect

Environment:
  ALL_SECRETS          JSON blob of all GitHub secrets (auto-populated in CI)
  KODY_TOKEN|GH_TOKEN|GITHUB_TOKEN|GH_PAT   auth token for gh/git operations

Exit codes (inherited from kody-lean run):
  0   success (PR opened, verify passed)
  1   agent reported FAILED (draft PR opened)
  2   verify failed (draft PR opened)
  3   no commits to ship
  4   PR creation failed
  5   uncommitted changes on target branch
  99  wrapper crashed
`

export function parseKody2Args(argv: string[]): Kody2Args {
  const result: Kody2Args = { errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--issue") {
      const n = parseInt(argv[++i] ?? "", 10)
      if (Number.isNaN(n) || n <= 0) result.errors.push("--issue requires a positive integer")
      else result.issueNumber = n
    } else if (arg === "--cwd") {
      result.cwd = argv[++i]
    } else if (arg === "--verbose") result.verbose = true
    else if (arg === "--quiet") result.quiet = true
    else if (arg === "--skip-install") result.skipInstall = true
    else if (arg === "--skip-litellm") result.skipLitellm = true
    else if (arg === "--package-manager") {
      const v = argv[++i]
      if (v === "pnpm" || v === "yarn" || v === "bun" || v === "npm") result.packageManager = v
      else result.errors.push(`--package-manager must be one of pnpm|yarn|bun|npm (got: ${v})`)
    } else if (arg === "--help" || arg === "-h") {
      result.errors.push("__HELP__")
    } else if (arg?.startsWith("--")) {
      result.errors.push(`unknown arg: ${arg}`)
    } else if (arg) {
      result.errors.push(`unexpected positional: ${arg}`)
    }
  }
  if (!result.issueNumber && !result.errors.includes("__HELP__")) {
    result.errors.push("--issue <N> is required")
  }
  return result
}

export function unpackAllSecrets(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALL_SECRETS
  if (!raw) return 0
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return 0 }
  if (!parsed || typeof parsed !== "object") return 0
  let count = 0
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string" || !v) continue
    if (env[k] !== undefined) continue
    env[k] = v
    count++
  }
  return count
}

export function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.KODY_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || env.GH_PAT
  if (token && !env.GH_TOKEN) env.GH_TOKEN = token
  return token
}

export function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun"
  return "npm"
}

function shellOut(cmd: string, args: string[], cwd: string, stream = true): number {
  try {
    execFileSync(cmd, args, {
      cwd,
      stdio: stream ? "inherit" : "pipe",
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1", CI: process.env.CI ?? "1" },
    })
    return 0
  } catch (err: unknown) {
    const e = err as { status?: number }
    return e.status ?? 1
  }
}

function isOnPath(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "pipe" })
    return true
  } catch { return false }
}

export function ensurePackageManagerInstalled(pm: PackageManager, cwd: string): number {
  if (pm === "npm" || isOnPath(pm)) return 0
  process.stdout.write(`→ kody2: ${pm} not on PATH — installing via npm install -g ${pm}\n`)
  return shellOut("npm", ["install", "-g", pm], cwd)
}

export function installDeps(pm: PackageManager, cwd: string): number {
  const ensureCode = ensurePackageManagerInstalled(pm, cwd)
  if (ensureCode !== 0) return ensureCode
  const args: Record<PackageManager, string[]> = {
    pnpm: ["install", "--frozen-lockfile"],
    yarn: ["install", "--frozen-lockfile"],
    bun:  ["install", "--frozen-lockfile"],
    npm:  ["ci"],
  }
  return shellOut(pm, args[pm], cwd)
}

export function installLitellmIfNeeded(cwd: string): number {
  try {
    const cfg = loadConfig(cwd)
    const model = parseProviderModel(cfg.agent.model)
    if (!needsLitellmProxy(model)) {
      process.stdout.write("→ kody2: provider is anthropic/claude, skipping LiteLLM install\n")
      return 0
    }
  } catch {
    // Config missing or invalid — install LiteLLM defensively; run() will fail later with a clearer error.
  }
  // Check if litellm already importable
  try {
    execFileSync("python3", ["-c", "import litellm"], { stdio: "pipe" })
    process.stdout.write("→ kody2: litellm already installed\n")
    return 0
  } catch {
    // not installed
  }
  process.stdout.write("→ kody2: installing litellm (pip install 'litellm[proxy]')\n")
  return shellOut("pip", ["install", "litellm[proxy]"], cwd)
}

export function configureGitIdentity(cwd: string): void {
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd, stdio: "pipe", encoding: "utf-8" }).trim()
    if (name) return
  } catch { /* not set */ }
  try { execFileSync("git", ["config", "user.name", "kody2-bot"], { cwd, stdio: "pipe" }) } catch { /* best effort */ }
  try { execFileSync("git", ["config", "user.email", "kody2-bot@users.noreply.github.com"], { cwd, stdio: "pipe" }) } catch { /* best effort */ }
}

function postFailureTail(issueNumber: number | undefined, cwd: string, reason: string): void {
  if (!issueNumber) return
  const logPath = path.join(cwd, ".kody-lean", "last-run.jsonl")
  let tail = ""
  try {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf-8")
      tail = content.slice(-3000)
    }
  } catch { /* best effort */ }
  const body = tail
    ? `⚠️ kody2 preflight failed: ${truncate(reason, 500)}\n\n<details><summary>Last-run log tail</summary>\n\n\`\`\`\n${tail}\n\`\`\`\n\n</details>`
    : `⚠️ kody2 preflight failed: ${truncate(reason, 1500)}`
  try { postIssueComment(issueNumber, body, cwd) } catch { /* best effort */ }
}

export async function runKody2(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(KODY2_HELP)
    return 0
  }

  const args = parseKody2Args(argv)
  if (args.errors.length > 0 && !args.errors.includes("__HELP__")) {
    for (const e of args.errors) process.stderr.write(`error: ${e}\n`)
    process.stderr.write("\n" + KODY2_HELP)
    return 64
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
  const issueNumber = args.issueNumber!

  process.stdout.write(`→ kody2 preflight (cwd=${cwd}, issue=${issueNumber})\n`)

  try {
    const n = unpackAllSecrets()
    if (n > 0) process.stdout.write(`→ kody2: unpacked ${n} secret(s) from ALL_SECRETS\n`)
    resolveAuthToken()

    const pm = args.packageManager ?? detectPackageManager(cwd)
    process.stdout.write(`→ kody2: package manager = ${pm}\n`)

    if (!args.skipInstall) {
      const code = installDeps(pm, cwd)
      if (code !== 0) {
        postFailureTail(issueNumber, cwd, `dependency install failed (${pm}, exit ${code})`)
        return 99
      }
    } else {
      process.stdout.write("→ kody2: skipping dep install (--skip-install)\n")
    }

    if (!args.skipLitellm) {
      const code = installLitellmIfNeeded(cwd)
      if (code !== 0) {
        postFailureTail(issueNumber, cwd, `litellm install failed (exit ${code})`)
        return 99
      }
    } else {
      process.stdout.write("→ kody2: skipping LiteLLM install (--skip-litellm)\n")
    }

    configureGitIdentity(cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody2] preflight crashed: ${msg}\n`)
    postFailureTail(issueNumber, cwd, `preflight crashed: ${msg}`)
    return 99
  }

  process.stdout.write("→ kody2: preflight done, handing off to kody-lean run\n\n")

  try {
    const result = await run({
      issueNumber,
      cwd,
      verbose: args.verbose,
      quiet: args.quiet,
    })
    if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 2) {
      // Only post tail on non-draft-PR failures; draft PRs already carry the failure body.
      postFailureTail(issueNumber, cwd, result.reason || `exit ${result.exitCode}`)
    }
    return result.exitCode
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody2] run crashed: ${msg}\n`)
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n")
    postFailureTail(issueNumber, cwd, `run crashed: ${msg}`)
    return 99
  }
}
