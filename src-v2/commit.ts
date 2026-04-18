import { execFileSync } from "child_process"

const FORBIDDEN_PATH_PREFIXES = [
  ".kody/",
  ".kody-engine/",
  ".kody-lean/",
  "node_modules/",
  "dist/",
  "build/",
]

const FORBIDDEN_PATH_EXACT = new Set([".env"])
const FORBIDDEN_PATH_SUFFIXES = [".log"]

const CONVENTIONAL_PREFIXES = [
  "feat:", "fix:", "chore:", "docs:", "refactor:", "test:", "perf:", "ci:", "style:", "build:", "revert:",
]

export interface CommitResult {
  committed: boolean
  pushed: boolean
  sha: string
  message: string
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: 120_000,
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

export function isForbiddenPath(p: string): boolean {
  if (FORBIDDEN_PATH_EXACT.has(p)) return true
  for (const pre of FORBIDDEN_PATH_PREFIXES) if (p.startsWith(pre)) return true
  for (const suf of FORBIDDEN_PATH_SUFFIXES) if (p.endsWith(suf)) return true
  return false
}

export function listChangedFiles(cwd?: string): string[] {
  const status = git(["status", "--porcelain"], cwd)
  if (!status) return []
  return status.split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
}

export function normalizeCommitMessage(raw: string): string {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "").trim()
  if (!trimmed) return "chore: kody-lean update"
  const firstLine = trimmed.split("\n")[0]
  for (const prefix of CONVENTIONAL_PREFIXES) {
    if (firstLine.toLowerCase().startsWith(prefix)) return trimmed
  }
  return `chore: ${trimmed}`
}

export function commitAndPush(
  branch: string,
  agentMessage: string,
  cwd?: string,
): CommitResult {
  const allChanged = listChangedFiles(cwd)
  const allowedFiles = allChanged.filter((f) => !isForbiddenPath(f))

  if (allowedFiles.length === 0) {
    return { committed: false, pushed: false, sha: "", message: "" }
  }

  for (const f of allowedFiles) {
    try { git(["add", "--", f], cwd) } catch { /* skip individual file errors */ }
  }

  const message = normalizeCommitMessage(agentMessage)
  try {
    git(["commit", "--no-gpg-sign", "-m", message], cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/nothing to commit/i.test(msg)) {
      return { committed: false, pushed: false, sha: "", message }
    }
    throw err
  }

  const sha = git(["rev-parse", "HEAD"], cwd).slice(0, 7)

  try {
    git(["push", "-u", "origin", branch], cwd)
  } catch {
    git(["push", "--force-with-lease", "-u", "origin", branch], cwd)
  }

  return { committed: true, pushed: true, sha, message }
}

export function hasCommitsAhead(branch: string, defaultBranch: string, cwd?: string): boolean {
  try {
    const out = git(["rev-list", "--count", `origin/${defaultBranch}..${branch}`], cwd)
    return parseInt(out, 10) > 0
  } catch {
    try {
      const out = git(["rev-list", "--count", `${defaultBranch}..${branch}`], cwd)
      return parseInt(out, 10) > 0
    } catch {
      return false
    }
  }
}
