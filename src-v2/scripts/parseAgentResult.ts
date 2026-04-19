/**
 * Postflight: extract DONE / COMMIT_MSG / PR_SUMMARY / FAILED from the agent's
 * final message, stuff them into ctx.data.
 */

import { parseAgentResult as parse } from "../prompt.js"
import type { PostflightScript } from "../executables/types.js"

export const parseAgentResult: PostflightScript = async (ctx, _profile, agentResult) => {
  if (!agentResult) {
    ctx.data.agentDone = false
    return
  }
  const parsed = parse(agentResult.finalText)
  ctx.data.agentDone = parsed.done
  ctx.data.commitMessage = parsed.commitMessage
  ctx.data.prSummary = parsed.prSummary
  ctx.data.agentFailureReason = parsed.failureReason
  ctx.data.agentOutcome = agentResult.outcome
  ctx.data.agentError = agentResult.error
}
