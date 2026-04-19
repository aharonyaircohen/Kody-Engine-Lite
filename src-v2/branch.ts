import { execFileSync } from "child_process"

export interface BranchResult {
  branch: string
  created: boolean
}

export class UncommittedChangesError extends Error {
  constructor(public branch: string) {
    super(`Uncommitted changes on branch '${branch}' — refusing to run to protect work in progress`)
    this.name = "UncommittedChangesError"
  }
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: 30_000,
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
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
  return slug ? `${issueNumber}-${slug}` : `${issueNumber}`
}

export function getCurrentBranch(cwd?: string): string {
  return git(["branch", "--show-current"], cwd)
}

export function hasUncommittedChanges(cwd?: string): boolean {
  return git(["status", "--porcelain", "--untracked-files=no"], cwd).length > 0
}

/**
 * Check out an existing PR locally via `gh pr checkout`. Returns the
 * local branch name (gh picks a name matching the PR head ref).
 */
export function checkoutPrBranch(prNumber: number, cwd?: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUSKY: "0",
    SKIP_HOOKS: "1",
    GH_TOKEN: process.env.GH_PAT?.trim() || process.env.GH_TOKEN || "",
  }
  execFileSync("gh", ["pr", "checkout", String(prNumber)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })
  return getCurrentBranch(cwd)
}

/**
 * Merge `origin/<baseBranch>` into the current branch. Returns "clean" on
 * success, "conflict" if unmerged paths remain (conflict markers left in
 * working tree), "error" on any other git failure.
 */
export function mergeBase(baseBranch: string, cwd?: string): "clean" | "conflict" | "error" {
  try { git(["fetch", "origin", baseBranch], cwd) } catch { return "error" }
  try {
    git(["merge", `origin/${baseBranch}`, "--no-edit", "--no-ff"], cwd)
    return "clean"
  } catch {
    try {
      const unmerged = git(["diff", "--name-only", "--diff-filter=U"], cwd)
      if (unmerged.length > 0) return "conflict"
    } catch { /* ignore */ }
    try { git(["merge", "--abort"], cwd) } catch { /* best effort */ }
    return "error"
  }
}

export function ensureFeatureBranch(
  issueNumber: number,
  title: string,
  defaultBranch: string,
  cwd?: string,
): BranchResult {
  const branchName = deriveBranchName(issueNumber, title)
  const current = getCurrentBranch(cwd)

  if (current === branchName) {
    if (hasUncommittedChanges(cwd)) throw new UncommittedChangesError(branchName)
    return { branch: branchName, created: false }
  }

  if (hasUncommittedChanges(cwd)) throw new UncommittedChangesError(current || "(detached)")

  try { git(["fetch", "origin"], cwd) } catch { /* best effort */ }

  try {
    git(["rev-parse", "--verify", `origin/${branchName}`], cwd)
    git(["checkout", branchName], cwd)
    try { git(["pull", "origin", branchName], cwd) } catch { /* best effort */ }
    return { branch: branchName, created: false }
  } catch { /* not on remote */ }

  try {
    git(["rev-parse", "--verify", branchName], cwd)
    git(["checkout", branchName], cwd)
    return { branch: branchName, created: false }
  } catch { /* not local either */ }

  try {
    git(["checkout", "-b", branchName, `origin/${defaultBranch}`], cwd)
  } catch {
    git(["checkout", "-b", branchName], cwd)
  }
  return { branch: branchName, created: true }
}
