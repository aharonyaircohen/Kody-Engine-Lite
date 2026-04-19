/**
 * Postflight: post the final status comment to whichever target the flow
 * script set (issue or PR). Also computes the terminal exit code from the
 * collected ctx.data state.
 */

import { postIssueComment as ghPostIssueComment, postPrReviewComment as ghPostPrReviewComment, truncate } from "../issue.js"
import type { PostflightScript } from "../executables/types.js"

export const postIssueComment: PostflightScript = async (ctx) => {
  // Preflight early-exit path: whoever set output.exitCode already did the user-facing comment.
  if (ctx.skipAgent && ctx.output.exitCode !== undefined) return

  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  if (!targetType || !targetNumber) return

  const commitResult = ctx.data.commitResult as { committed: boolean } | undefined
  const hasCommits = Boolean(ctx.data.hasCommitsAhead)
  const prUrl = ctx.output.prUrl

  if (!commitResult?.committed && !hasCommits) {
    const reason = "no changes to commit"
    postWith(targetType, targetNumber, `⚠️ kody2 FAILED: ${reason}`, ctx.cwd)
    ctx.output.exitCode = 3
    ctx.output.reason = reason
    return
  }

  if (ctx.output.exitCode === 4 && ctx.data.prCrashReason) {
    postWith(targetType, targetNumber, `⚠️ kody2 FAILED: ${truncate(ctx.data.prCrashReason as string, 1500)}`, ctx.cwd)
    ctx.output.reason = ctx.data.prCrashReason as string
    return
  }

  const failureReason = computeFailureReason(ctx)
  const isFailure = failureReason.length > 0

  const msg = isFailure
    ? `⚠️ kody2 FAILED: ${truncate(failureReason, 1500)}${prUrl ? ` — draft PR: ${prUrl}` : ""}`
    : `✅ kody2 PR opened: ${prUrl}`
  postWith(targetType, targetNumber, msg, ctx.cwd)

  let exitCode = 0
  const agentDone = Boolean(ctx.data.agentDone)
  const verifyOk = ctx.data.verifyOk !== false
  const misses = (ctx.data.coverageMisses as unknown[] | undefined) ?? []
  if (!agentDone || misses.length > 0) exitCode = 1
  else if (!verifyOk) exitCode = 2
  ctx.output.exitCode = exitCode
  ctx.output.reason = failureReason || undefined
}

function computeFailureReason(ctx: { data: Record<string, unknown> }): string {
  const misses = (ctx.data.coverageMisses as { expectedTest: string }[] | undefined) ?? []
  if (misses.length > 0) return `missing tests: ${misses.map((m) => m.expectedTest).join(", ")}`

  const agentDone = Boolean(ctx.data.agentDone)
  if (!agentDone) {
    return (ctx.data.agentFailureReason as string) || (ctx.data.agentError as string) || "agent did not emit DONE"
  }
  if (ctx.data.verifyOk === false) return (ctx.data.verifyReason as string) || "verify failed"
  return ""
}

function postWith(type: "issue" | "pr", n: number, body: string, cwd?: string): void {
  try {
    if (type === "issue") ghPostIssueComment(n, body, cwd)
    else ghPostPrReviewComment(n, body, cwd)
  } catch { /* best effort */ }
}
