/**
 * Flow script for `args.mode === "fix"`.
 * Loads the PR, checks it out, reads the PR's latest review (or --feedback),
 * posts a "started" comment on the PR.
 */

import { getPr, getPrDiff, getPrLatestReviewBody, postPrReviewComment, truncate } from "../issue.js"
import { checkoutPrBranch, getCurrentBranch } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"

export const fixFlow: PreflightScript = async (ctx) => {
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

  const inlineFeedback = (ctx.args.feedback as string | undefined)?.trim()
  const feedback = inlineFeedback || getPrLatestReviewBody(prNumber, ctx.cwd)
  if (!feedback.trim()) {
    ctx.output.exitCode = 1
    ctx.output.reason = "no --feedback provided and no review/body text found on PR"
    ctx.skipAgent = true
    return
  }
  ctx.data.feedback = feedback
  ctx.data.prDiff = getPrDiff(prNumber, ctx.cwd)

  tryPostPr(prNumber,
    `⚙️ kody2 fix started on \`${ctx.data.branch}\` — applying feedback (${truncate(feedback.replace(/\n/g, " "), 200)})`,
    ctx.cwd)
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try { postPrReviewComment(prNumber, body, cwd) } catch { /* best effort */ }
}
