/**
 * Flow script for `args.mode === "run"`.
 * Loads the issue, creates/checks out a feature branch, posts the "started"
 * comment. Issue number lives in `ctx.args.issue`.
 */

import { getIssue, postIssueComment } from "../issue.js"
import { ensureFeatureBranch, UncommittedChangesError } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"

const RUN_URL = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : ""

export const runFlow: PreflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number

  const issue = getIssue(issueNumber, ctx.cwd)
  ctx.data.issue = issue
  ctx.data.commentTargetType = "issue"
  ctx.data.commentTargetNumber = issueNumber

  try {
    const branchInfo = ensureFeatureBranch(issueNumber, issue.title, ctx.config.git.defaultBranch, ctx.cwd)
    ctx.data.branch = branchInfo.branch
  } catch (err) {
    if (err instanceof UncommittedChangesError) {
      ctx.output.exitCode = 5
      ctx.output.reason = err.message
      ctx.skipAgent = true
      tryPost(issueNumber, `⚠️ kody2 refused to start: ${err.message}`, ctx.cwd)
      return
    }
    throw err
  }

  const startMsg = RUN_URL
    ? `⚙️ kody2 started — branch \`${ctx.data.branch}\`, run ${RUN_URL}`
    : `⚙️ kody2 started — branch \`${ctx.data.branch}\``
  tryPost(issueNumber, startMsg, ctx.cwd)
}

function tryPost(issueNumber: number, body: string, cwd?: string): void {
  try { postIssueComment(issueNumber, body, cwd) } catch { /* best effort */ }
}
