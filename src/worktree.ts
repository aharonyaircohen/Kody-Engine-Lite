import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { logger } from "./logger.js"

function getHookSafeEnv(): Record<string, string> {
  return { ...process.env as Record<string, string>, HUSKY: "0", SKIP_HOOKS: "1" }
}

function git(args: string[], options?: { timeout?: number; cwd?: string }): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: options?.timeout ?? 30_000,
    cwd: options?.cwd,
    env: getHookSafeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

const WORKTREE_BASE = "/tmp/kody-worktrees"

export function worktreePath(taskId: string, subTaskId: string): string {
  return path.join(WORKTREE_BASE, taskId, subTaskId)
}

export function createWorktree(
  projectDir: string,
  wtPath: string,
  branchName: string,
): void {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  git(["worktree", "add", "-b", branchName, wtPath, "HEAD"], { cwd: projectDir })
  logger.info(`  Worktree created: ${wtPath} (branch: ${branchName})`)
}

export function removeWorktree(projectDir: string, wtPath: string): void {
  try {
    git(["worktree", "remove", wtPath, "--force"], { cwd: projectDir })
    logger.info(`  Worktree removed: ${wtPath}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`  Failed to remove worktree ${wtPath}: ${msg}`)
  }
}

export function cleanupWorktrees(projectDir: string, taskId: string): void {
  const taskWorktreeDir = path.join(WORKTREE_BASE, taskId)
  if (!fs.existsSync(taskWorktreeDir)) return

  try {
    const entries = fs.readdirSync(taskWorktreeDir)
    for (const entry of entries) {
      const wtPath = path.join(taskWorktreeDir, entry)
      removeWorktree(projectDir, wtPath)
    }
    fs.rmSync(taskWorktreeDir, { recursive: true, force: true })
    logger.info(`  Cleaned up all worktrees for task ${taskId}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`  Failed to cleanup worktrees: ${msg}`)
  }

  // Prune stale worktree refs
  try {
    git(["worktree", "prune"], { cwd: projectDir })
  } catch { /* non-critical */ }
}

/**
 * Merge a sub-task branch into the current branch.
 * Returns "clean" on success, "conflict" if merge conflicts exist.
 */
export function mergeSubTaskBranch(
  branchName: string,
  cwd: string,
): "clean" | "conflict" {
  try {
    git(["merge", branchName, "--no-edit"], { cwd, timeout: 60_000 })
    logger.info(`  Merged branch: ${branchName}`)
    return "clean"
  } catch {
    // Check if it's a conflict
    try {
      const unmerged = git(["diff", "--name-only", "--diff-filter=U"], { cwd })
      if (unmerged.trim()) {
        logger.warn(`  Merge conflict on branch: ${branchName}`)
        // Abort the merge so we leave the repo clean
        try { git(["merge", "--abort"], { cwd }) } catch { /* best effort */ }
        return "conflict"
      }
    } catch { /* ignore */ }

    // Not a conflict — some other merge error, treat as conflict
    try { git(["merge", "--abort"], { cwd }) } catch { /* best effort */ }
    return "conflict"
  }
}

/**
 * Get files changed in a worktree (staged + unstaged vs HEAD).
 */
export function getWorktreeChangedFiles(wtPath: string): string[] {
  const files = new Set<string>()
  try {
    // Staged changes
    const staged = git(["diff", "--cached", "--name-only"], { cwd: wtPath })
    if (staged) staged.split("\n").filter(Boolean).forEach((f) => files.add(f))
    // Unstaged changes (tracked files)
    const unstaged = git(["diff", "--name-only"], { cwd: wtPath })
    if (unstaged) unstaged.split("\n").filter(Boolean).forEach((f) => files.add(f))
  } catch { /* ignore */ }
  return [...files]
}
