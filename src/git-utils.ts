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

  // Fetch origin — log the error so permission issues don't masquerade
  // as "branch not found" when checkout/pull fails downstream.
  try {
    git(["fetch", "origin"], { cwd, timeout: 30_000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`  Failed to fetch origin: ${msg}`)
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

export function syncWithDefault(cwd?: string, branch?: string): void {
  const defaultBranch = branch ?? getDefaultBranch(cwd)
  const current = getCurrentBranch(cwd)

  if (current === defaultBranch) return // already on default, no merge needed

  // Fetch latest
  try {
    git(["fetch", "origin", defaultBranch], { cwd, timeout: 30_000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`  Failed to fetch latest from origin: ${msg}`)
    return
  }

  // Merge default into feature branch
  try {
    git(["merge", `origin/${defaultBranch}`, "--no-edit"], { cwd, timeout: 30_000 })
    logger.info(`  Synced with origin/${defaultBranch}`)
  } catch {
    // Merge conflict — abort and warn
    try {
      git(["merge", "--abort"], { cwd })
    } catch (abortErr) {
      logger.warn(`  Failed to abort merge: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`)
    }
    logger.warn(`  Merge conflict with origin/${defaultBranch} — skipping sync`)
  }
}

/**
 * Attempt to merge default branch. Returns "clean" on success, "conflict" if
 * conflicts remain (markers left in working tree), or "error" on other failure.
 */
export function mergeDefault(cwd?: string): "clean" | "conflict" | "error" {
  const defaultBranch = getDefaultBranch(cwd)
  const current = getCurrentBranch(cwd)
  if (current === defaultBranch) return "clean"

  try {
    git(["fetch", "origin", defaultBranch], { cwd, timeout: 30_000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`  Failed to fetch latest from origin: ${msg}`)
    return "error"
  }

  try {
    git(["merge", `origin/${defaultBranch}`, "--no-edit"], { cwd, timeout: 30_000 })
    logger.info(`  Merged origin/${defaultBranch} cleanly`)
    return "clean"
  } catch {
    // Check if it's a conflict (unmerged files exist) vs some other error
    try {
      const unmerged = git(["diff", "--name-only", "--diff-filter=U"], { cwd })
      if (unmerged.trim()) return "conflict"
    } catch { /* ignore — checking for conflict marker, not critical */ }
    // Not a conflict — some other merge error
    try {
      git(["merge", "--abort"], { cwd })
    } catch (abortErr) {
      logger.warn(`  Failed to abort merge: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`)
    }
    return "error"
  }
}

export function getConflictedFiles(cwd?: string): string[] {
  try {
    const output = git(["diff", "--name-only", "--diff-filter=U"], { cwd })
    return output ? output.split("\n") : []
  } catch {
    return []
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

export function getDiffFiles(baseBranch: string, cwd?: string): string[] {
  try {
    const output = git(["diff", "--name-only", `origin/${baseBranch}...HEAD`], { cwd })
    if (!output) return []
    return output.split("\n").filter((f) => f && !f.startsWith(".kody/"))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`  Failed to get diff files: ${msg}`)
    return []
  }
}

export function filterFindingsByDiffFiles(
  findings: string[],
  diffFiles: string[],
): string[] {
  // When no diff files provided, return all findings (no filtering possible)
  if (diffFiles.length === 0) return findings

  return findings.filter((finding) => {
    // Always filter out .kody/ references
    const fileMatch = finding.match(/\*\*([^*]+)\*\*/)
    if (fileMatch) {
      const filePath = fileMatch[1]
      if (filePath.startsWith(".kody/")) return false
      return diffFiles.includes(filePath)
    }
    // Keep findings with no file reference (general findings)
    return true
  })
}

// ─── Release helpers ────────────────────────────────────────────────────────

export function getLatestTag(cwd?: string, pattern: string = "v*"): string | null {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", pattern], { cwd })
  } catch {
    return null
  }
}

export function getLogSince(ref: string | null, cwd?: string): string[] {
  const range = ref ? `${ref}..HEAD` : "HEAD"
  try {
    const output = git(["log", range, "--pretty=format:%h %s"], { cwd })
    return output ? output.split("\n") : []
  } catch {
    return []
  }
}

export function createTag(tag: string, message: string, cwd?: string): void {
  git(["tag", "-a", tag, "-m", message], { cwd })
}

export function pushTags(cwd?: string): void {
  git(["push", "origin", "--tags"], { cwd, timeout: 60_000 })
}

export function createBranch(name: string, cwd?: string): void {
  git(["checkout", "-b", name], { cwd })
}

export function checkoutBranch(name: string, cwd?: string): void {
  git(["checkout", name], { cwd })
}

/**
 * Revert a commit. Handles both merge commits (-m 1) and squash commits.
 * On conflict, aborts the revert and returns an error.
 */
export function revertCommit(
  sha: string,
  isMerge: boolean,
  cwd?: string,
): { success: boolean; error?: string } {
  const args = ["revert", "--no-edit"]
  if (isMerge) args.push("-m", "1")
  args.push(sha)

  try {
    git(args, { cwd, timeout: 60_000 })
    return { success: true }
  } catch (err) {
    // Check if it's a conflict
    try {
      const unmerged = git(["diff", "--name-only", "--diff-filter=U"], { cwd })
      if (unmerged.trim()) {
        try { git(["revert", "--abort"], { cwd }) } catch { /* best effort */ }
        return { success: false, error: `Conflict in files:\n${unmerged.trim()}` }
      }
    } catch { /* ignore */ }

    // If isMerge failed, retry without -m (might be a squash merge)
    if (isMerge) {
      try {
        git(["revert", "--no-edit", sha], { cwd, timeout: 60_000 })
        return { success: true }
      } catch { /* fall through to general error */ }
    }

    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

export function pushBranch(cwd?: string): void {
  try {
    git(["push", "-u", "origin", "HEAD"], { cwd, timeout: 120_000 })
  } catch {
    // Fast-forward push failed — likely a rerun that diverged from remote.
    // Use --force-with-lease for safe overwrite (refuses if remote changed
    // since our last fetch, protecting against concurrent pushes).
    logger.info("  Push rejected (non-fast-forward), retrying with --force-with-lease")
    git(["push", "--force-with-lease", "-u", "origin", "HEAD"], { cwd, timeout: 120_000 })
  }
  logger.info("  Pushed to origin")
}
