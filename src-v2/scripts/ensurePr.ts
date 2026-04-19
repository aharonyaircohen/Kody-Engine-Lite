/**
 * Postflight: open or update the PR. Draft on any failure, normal on full success.
 * No-op if commitAndPush didn't produce any change and the branch isn't ahead.
 */

import { ensurePr as doEnsurePr } from "../pr.js"
import type { PostflightScript } from "../executables/types.js"

export const ensurePr: PostflightScript = async (ctx) => {
  if (ctx.skipAgent && ctx.output.exitCode !== undefined && ctx.output.exitCode !== 0) {
    // Preflight already decided to bail out without a PR (e.g. refused-to-start on WIP).
    // No commit happened → nothing to PR.
    return
  }

  const commitResult = ctx.data.commitResult as { committed: boolean } | undefined
  const hasCommits = Boolean(ctx.data.hasCommitsAhead)
  if (!commitResult?.committed && !hasCommits) {
    // Nothing to ship. Let postIssueComment surface the "no changes" state.
    return
  }

  const branch = ctx.data.branch as string | undefined
  if (!branch) return

  const failureReason = computeFailureReason(ctx)
  const isFailure = failureReason.length > 0
  const changedFiles = (ctx.data.changedFiles as string[] | undefined) ?? []

  const issue = ctx.data.issue as { title?: string } | undefined
  const pr = ctx.data.pr as { title?: string } | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  const title = issue?.title ?? pr?.title ?? `kody2 changes`

  try {
    const result = doEnsurePr({
      branch,
      defaultBranch: ctx.config.git.defaultBranch,
      issueNumber: targetNumber,
      issueTitle: title,
      draft: isFailure,
      failureReason: isFailure ? failureReason : undefined,
      changedFiles,
      agentSummary: ctx.data.prSummary as string | undefined,
      cwd: ctx.cwd,
    })
    ctx.output.prUrl = result.url
    ctx.data.prResult = result
  } catch (err) {
    const reason = `PR creation failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.data.prCrashReason = reason
    ctx.output.exitCode = 4
    ctx.output.reason = reason
  }
}

function computeFailureReason(ctx: { data: Record<string, unknown> }): string {
  const misses = (ctx.data.coverageMisses as { expectedTest: string }[] | undefined) ?? []
  if (misses.length > 0) return `missing tests: ${misses.map((m) => m.expectedTest).join(", ")}`

  const agentDone = Boolean(ctx.data.agentDone)
  if (!agentDone) {
    return (
      (ctx.data.agentFailureReason as string) ||
      (ctx.data.agentError as string) ||
      (ctx.data.commitCrash as string) ||
      "agent did not emit DONE"
    )
  }

  if (ctx.data.verifyOk === false) return (ctx.data.verifyReason as string) || "verify failed"

  return ""
}
