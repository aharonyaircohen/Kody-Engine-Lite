import { execFileSync } from "child_process"
import { logger } from "./logger.js"
import { getProjectConfig } from "./config.js"

const BASE_BRANCHES = ["dev", "main", "master"]

let _hookSafeEnv: Record<string, string> | null = null
function getHookSafeEnv(): Record<string, string> {
  if (!_hookSafeEnv) {
    _hookSafeEnv = { ...process.env as Record<string, string>, HUSKY: "0", SKIP_HOOKS: "1" }
  }
  return _hookSafeEnv
}

function git(args: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string> }): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: options?.timeout ?? 30_000,
    cwd: options?.cwd,
    env: options?.env ?? getHookSafeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

export function deriveBranchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "")
  return `${issueNumber}-${slug}`
}

export function getDefaultBranch(cwd?: string): string {
  // Method 0: use kody.config.json if it specifies a default branch
  try {
    const config = getProjectConfig()
    if (config.git?.defaultBranch) {
      return config.git.defaultBranch
    }
  } catch {
    // Fall through to git-based detection
  }

  // Method 1: symbolic-ref (fast, no network)
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd })
    return ref.replace("refs/remotes/origin/", "")
  } catch {
    // Fall through
  }

  // Method 2: remote show (needs network, 10s timeout)
  try {
    const output = git(["remote", "show", "origin"], { cwd, timeout: 10_000 })
    const match = output.match(/HEAD branch:\s*(\S+)/)
    if (match) return match[1]
  } catch {
    // Fall through
  }

  // Method 3: hardcoded fallback
  return "dev"
}

export function getCurrentBranch(cwd?: string): string {
  return git(["branch", "--show-current"], { cwd })
}

export function ensureFeatureBranch(
  issueNumber: number,
  title: string,
  cwd?: string,
): string {
  const current = getCurrentBranch(cwd)
  const branchName = deriveBranchName(issueNumber, title)

  // Already on the correct feature branch for this issue
  if (current === branchName || current.startsWith(`${issueNumber}-`)) {
    logger.info(`  Already on feature branch: ${current}`)
    return current
  }

  // On a different feature branch — switch to default first
  if (!BASE_BRANCHES.includes(current) && current !== "") {
    const defaultBranch = getDefaultBranch(cwd)
    logger.info(`  Switching from ${current} to ${defaultBranch} before creating ${branchName}`)
    try {
      git(["checkout", defaultBranch], { cwd })
    } catch {
      logger.warn(`  Failed to checkout ${defaultBranch}, aborting branch creation`)
      return current
    }
  }

  // Fetch origin
  try {
    git(["fetch", "origin"], { cwd, timeout: 30_000 })
  } catch {
    logger.warn("  Failed to fetch origin")
  }

  // Check if branch exists on remote
  try {
    git(["rev-parse", "--verify", `origin/${branchName}`], { cwd })
    git(["checkout", branchName], { cwd })
    git(["pull", "origin", branchName], { cwd, timeout: 30_000 })
    logger.info(`  Checked out existing remote branch: ${branchName}`)
    return branchName
  } catch {
    // Branch doesn't exist on remote
  }

  // Check if branch exists locally
  try {
    git(["rev-parse", "--verify", branchName], { cwd })
    git(["checkout", branchName], { cwd })
    logger.info(`  Checked out existing local branch: ${branchName}`)
    return branchName
  } catch {
    // Branch doesn't exist locally either
  }

  // Create new branch tracking default branch
  const defaultBranch = getDefaultBranch(cwd)
  try {
    git(["checkout", "-b", branchName, `origin/${defaultBranch}`], { cwd })
  } catch {
    // If origin/default doesn't exist, create from current HEAD
    git(["checkout", "-b", branchName], { cwd })
  }
  logger.info(`  Created new branch: ${branchName}`)
  return branchName
}

export function syncWithDefault(cwd?: string): void {
  const defaultBranch = getDefaultBranch(cwd)
  const current = getCurrentBranch(cwd)

  if (current === defaultBranch) return // already on default, no merge needed

  // Fetch latest
  try {
    git(["fetch", "origin", defaultBranch], { cwd, timeout: 30_000 })
  } catch {
    logger.warn("  Failed to fetch latest from origin")
    return
  }

  // Merge default into feature branch
  try {
    git(["merge", `origin/${defaultBranch}`, "--no-edit"], { cwd, timeout: 30_000 })
    logger.info(`  Synced with origin/${defaultBranch}`)
  } catch {
    // Merge conflict — abort and warn
    try { git(["merge", "--abort"], { cwd }) } catch { /* ignore */ }
    logger.warn(`  Merge conflict with origin/${defaultBranch} — skipping sync`)
  }
}

export function commitAll(
  message: string,
  cwd?: string,
): { success: boolean; hash: string; message: string } {
  // Check for changes
  const status = git(["status", "--porcelain"], { cwd })
  if (!status) {
    return { success: false, hash: "", message: "No changes to commit" }
  }

  git(["add", "."], { cwd })
  git(["commit", "--no-gpg-sign", "-m", message], { cwd })
  const hash = git(["rev-parse", "HEAD"], { cwd }).slice(0, 7)

  logger.info(`  Committed: ${hash} ${message}`)
  return { success: true, hash, message }
}

export function pushBranch(cwd?: string): void {
  git(["push", "-u", "origin", "HEAD"], { cwd, timeout: 120_000 })
  logger.info("  Pushed to origin")
}

export function getChangedFiles(baseBranch: string, cwd?: string): string[] {
  try {
    const output = git(["diff", "--name-only", `origin/${baseBranch}...HEAD`], { cwd })
    return output ? output.split("\n").filter(Boolean) : []
  } catch {
    return []
  }
}

export function getDiff(baseBranch: string, cwd?: string): string {
  try {
    return git(["diff", `origin/${baseBranch}...HEAD`], { cwd })
  } catch {
    return ""
  }
}
