/**
 * Postflight: stage allowed files, commit, push. Stashes the commit result
 * on ctx.data.commitResult for ensurePr/postIssueComment to consume.
 *
 * For the resolve flow: stages all files explicitly (merge commit needs -A).
 */

import { execFileSync } from "child_process"
import { commitAndPush as doCommitAndPush, hasCommitsAhead, listChangedFiles, isForbiddenPath } from "../commit.js"
import type { PostflightScript } from "../executables/types.js"

export const commitAndPush: PostflightScript = async (ctx) => {
  const branch = ctx.data.branch as string | undefined
  if (!branch) {
    ctx.data.commitResult = { committed: false, pushed: false }
    return
  }

  // Resolve flow: make sure conflict-resolved files get staged.
  if (ctx.args.mode === "resolve") {
    try {
      execFileSync("git", ["add", "-A"], { cwd: ctx.cwd, env: { ...process.env, HUSKY: "0" }, stdio: "pipe" })
    } catch { /* best effort */ }
  }

  const fallbackMsg = defaultCommitMessage(ctx.args.mode as string | undefined, ctx.data)
  const message = (ctx.data.commitMessage as string) || fallbackMsg

  try {
    const result = doCommitAndPush(branch, message, ctx.cwd)
    ctx.data.commitResult = result
    ctx.data.changedFiles = listChangedFiles(ctx.cwd).filter((f) => !isForbiddenPath(f))
  } catch (err) {
    ctx.data.commitCrash = err instanceof Error ? err.message : String(err)
    ctx.data.commitResult = { committed: false, pushed: false }
  }

  ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
}

function defaultCommitMessage(mode: string | undefined, data: Record<string, unknown>): string {
  switch (mode) {
    case "run":     return `chore: kody2 changes for #${data.commentTargetNumber}`
    case "fix":     return `chore(fix): kody2 fix for PR #${data.commentTargetNumber}`
    case "fix-ci":  return `fix(ci): kody2 fix-ci for PR #${data.commentTargetNumber}`
    case "resolve": return `fix: resolve merge conflicts with ${data.baseBranch}`
    default:        return `chore: kody2 changes`
  }
}
