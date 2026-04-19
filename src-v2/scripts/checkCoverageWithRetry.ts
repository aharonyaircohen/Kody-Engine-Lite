/**
 * Postflight: enforce kody.config.json testRequirements on newly added files.
 * If any sibling test is missing, re-invoke the agent once with the gap as
 * feedback. After retry, re-check; remaining misses become ctx.data.coverageMisses.
 *
 * The retry agent call happens via the executor's cached invokeAgent closure,
 * which the executor stashes on ctx.data.__invokeAgent before running
 * postflight. (Yes, this is a controlled escape-hatch — the only postflight
 * script that re-invokes the agent.)
 */

import { checkCoverage, getAddedFiles, formatMissesForFeedback, type MissingTest } from "../coverage.js"
import type { PostflightScript, Context } from "../executables/types.js"
import { parseAgentResult } from "../prompt.js"
import type { AgentResult } from "../agent.js"

type Invoker = (prompt: string) => Promise<AgentResult>

export const checkCoverageWithRetry: PostflightScript = async (ctx) => {
  const reqs = (ctx.data.coverageRules as { pattern: string; requireSibling: string }[]) ?? []
  if (reqs.length === 0) {
    ctx.data.coverageMisses = []
    return
  }
  if (!ctx.data.agentDone) {
    ctx.data.coverageMisses = []
    return
  }

  const misses = checkCoverage(getAddedFiles(ctx.config.git.defaultBranch, ctx.cwd), reqs)
  if (misses.length === 0) {
    ctx.data.coverageMisses = []
    return
  }

  const invoker = ctx.data.__invokeAgent as Invoker | undefined
  const basePrompt = ctx.data.prompt as string | undefined
  if (!invoker || !basePrompt) {
    ctx.data.coverageMisses = misses
    return
  }

  process.stderr.write(`[kody2] coverage check found ${misses.length} missing test(s); retrying agent once\n`)
  const retryPrompt = `${basePrompt}\n\n# Coverage failure (retry)\n${formatMissesForFeedback(misses)}`
  const retry = await invoker(retryPrompt)
  const retryParsed = parseAgentResult(retry.finalText)
  if (retry.outcome === "completed" && retryParsed.done) {
    ctx.data.agentDone = true
    ctx.data.commitMessage = retryParsed.commitMessage || (ctx.data.commitMessage as string)
    ctx.data.prSummary = retryParsed.prSummary || (ctx.data.prSummary as string)
  }
  const finalMisses = checkCoverage(getAddedFiles(ctx.config.git.defaultBranch, ctx.cwd), reqs)
  ctx.data.coverageMisses = finalMisses
}

/** Type-only export for callers who want to construct the invoker. */
export type CoverageInvoker = (ctx: Context) => Invoker
