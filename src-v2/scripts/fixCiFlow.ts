/**
 * Flow script for `args.mode === "fix-ci"`.
 * Loads PR, checks it out, fetches the failing workflow run + log tail.
 */

import { getPr, getPrDiff, postPrReviewComment } from "../issue.js"
import { checkoutPrBranch, getCurrentBranch } from "../branch.js"
import { getLatestFailedRunForPr, getFailedRunLogTail } from "../workflow.js"
import { getRunUrl } from "../gha.js"
import type { PreflightScript } from "../executables/types.js"

const LOG_MAX_BYTES = 30_000

export const fixCiFlow: PreflightScript = async (ctx) => {
  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)
  if (pr.state !== "OPEN") {
    ctx.output.exitCode = 1
    ctx.output.reason = `PR #${prNumber} is not OPEN (state: ${pr.state})`
    ctx.skipAgent = true
    return
  }
  ctx.data.pr = pr
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = prNumber

  checkoutPrBranch(prNumber, ctx.cwd)
  ctx.data.branch = getCurrentBranch(ctx.cwd)

  let runId = ctx.args.runId as string | undefined
  let workflowName = ""
  let failedRunUrl = ""
  if (!runId) {
    const run = getLatestFailedRunForPr(prNumber, ctx.cwd)
    if (!run) {
      ctx.output.exitCode = 1
      ctx.output.reason = `no failed workflow run found on PR #${prNumber}'s branch`
      ctx.skipAgent = true
      return
    }
    runId = run.id
    workflowName = run.workflowName
    failedRunUrl = run.url
  }

  const logTail = getFailedRunLogTail(runId, LOG_MAX_BYTES, ctx.cwd)
  if (!logTail) {
    ctx.output.exitCode = 1
    ctx.output.reason = `failed to fetch log tail for run ${runId}`
    ctx.skipAgent = true
    return
  }

  ctx.data.failedRunId = runId
  ctx.data.failedWorkflowName = workflowName
  ctx.data.failedRunUrl = failedRunUrl
  ctx.data.failedLogTail = logTail
  ctx.data.prDiff = getPrDiff(prNumber, ctx.cwd)

  const runUrl = getRunUrl()
  const runSuffix = runUrl ? `, kody2 run ${runUrl}` : ""
  tryPostPr(prNumber, `⚙️ kody2 fix-ci started on \`${ctx.data.branch}\`${runSuffix} — analyzing workflow run ${runId}`, ctx.cwd)
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try { postPrReviewComment(prNumber, body, cwd) } catch { /* best effort */ }
}
