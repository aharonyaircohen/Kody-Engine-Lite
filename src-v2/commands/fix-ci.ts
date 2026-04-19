import * as path from "path"
import { loadConfig, parseProviderModel } from "../config.js"
import { startLitellmIfNeeded } from "../litellm.js"
import { runAgent } from "../agent.js"
import { checkoutPrBranch, getCurrentBranch } from "../branch.js"
import {
  commitAndPush,
  hasCommitsAhead,
  listChangedFiles,
  isForbiddenPath,
} from "../commit.js"
import { ensurePr } from "../pr.js"
import { verifyAll, summarizeFailure } from "../verify.js"
import {
  getPr,
  getPrDiff,
  postPrReviewComment,
  truncate,
} from "../issue.js"
import { loadProjectConventions, parseAgentResult } from "../prompt.js"
import { checkCoverage, getAddedFiles, formatMissesForFeedback, type MissingTest } from "../coverage.js"
import { getLatestFailedRunForPr, getFailedRunLogTail } from "../workflow.js"

const PR_DIFF_MAX_BYTES = 30_000
const LOG_MAX_BYTES = 30_000

export interface FixCiOptions {
  prNumber: number
  runId?: string
  cwd?: string
  verbose?: boolean
  quiet?: boolean
}

export interface FixCiResult {
  exitCode: number
  prUrl?: string
  reason?: string
}

function buildFixCiPrompt(args: {
  prNumber: number
  prTitle: string
  featureBranch: string
  workflowName: string
  failedRunUrl: string
  logTail: string
  diff: string
  conventionsBlock: string
}): string {
  return `You are Kody, an autonomous engineer. A CI workflow on PR #${args.prNumber} (\`${args.featureBranch}\`) is failing. Read the failed-step log tail below and fix the root cause. The wrapper handles git/gh — you do not.

# PR #${args.prNumber}: ${args.prTitle}

# Failing workflow
- Workflow: ${args.workflowName}
- Run URL:  ${args.failedRunUrl}

# Failed-step log (truncated, most recent ~30KB)

\`\`\`
${truncate(args.logTail, LOG_MAX_BYTES)}
\`\`\`

${args.conventionsBlock}# Current PR diff (truncated)

\`\`\`diff
${truncate(args.diff, PR_DIFF_MAX_BYTES)}
\`\`\`

# Required steps
1. Read the log carefully. Identify the actual failure — compile error, failing test, lint rule, missing dep, etc.
2. Make the minimum edits to fix the root cause. Do NOT disable tests or rules just to make CI pass.
3. Re-run the relevant quality command locally with Bash and confirm exit 0.
4. Final message format (or \`FAILED: <reason>\` on failure):

   DONE
   COMMIT_MSG: fix(ci): <short root-cause description>
   PR_SUMMARY:
   <2-4 bullets: what was failing, what you changed, why it fixes it>

# Rules
- Do NOT run git/gh. Wrapper handles it.
- Do NOT disable/skip tests or lint rules just to pass CI.
- If the failure is environmental (missing secret, broken runner) and not code, emit:
  FAILED: <explanation>
- Stay on \`${args.featureBranch}\`.`
}

export async function runFixCi(opts: FixCiOptions): Promise<FixCiResult> {
  const cwd = opts.cwd ?? process.cwd()

  let config: ReturnType<typeof loadConfig>
  try { config = loadConfig(cwd) } catch (err) {
    return finishFixCi({ exitCode: 99, reason: `config error: ${errMsg(err)}` })
  }

  let pr
  try { pr = getPr(opts.prNumber, cwd) } catch (err) {
    return finishFixCi({ exitCode: 99, reason: `failed to fetch PR #${opts.prNumber}: ${errMsg(err)}` })
  }
  if (pr.state !== "OPEN") {
    return finishFixCi({ exitCode: 1, reason: `PR #${opts.prNumber} is not OPEN (state: ${pr.state})` })
  }

  let featureBranch: string
  try {
    checkoutPrBranch(opts.prNumber, cwd)
    featureBranch = getCurrentBranch(cwd)
  } catch (err) {
    return finishFixCi({ exitCode: 99, reason: `failed to check out PR branch: ${errMsg(err)}` })
  }

  let runId = opts.runId
  let workflowName = ""
  let failedRunUrl = ""
  if (!runId) {
    const run = getLatestFailedRunForPr(opts.prNumber, cwd)
    if (!run) {
      return finishFixCi({ exitCode: 1, reason: `no failed workflow run found on PR #${opts.prNumber}'s branch` })
    }
    runId = run.id
    workflowName = run.workflowName
    failedRunUrl = run.url
  }

  const logTail = getFailedRunLogTail(runId, LOG_MAX_BYTES, cwd)
  if (!logTail) {
    return finishFixCi({ exitCode: 1, reason: `failed to fetch log tail for run ${runId}` })
  }

  tryPostPr(opts.prNumber, `⚙️ kody2 fix-ci started on \`${featureBranch}\` — analyzing workflow run ${runId}`, cwd)

  const diff = getPrDiff(opts.prNumber, cwd)
  const conventions = loadProjectConventions(cwd)
  const conventionsBlock = conventions.length > 0
    ? "# Project conventions (AUTHORITATIVE)\n\n" + conventions.map((c) => `## ${c.path}\n\n${c.content}\n\n`).join("") + "\n"
    : ""

  let model
  try { model = parseProviderModel(config.agent.model) } catch (err) {
    return finishFixCi({ exitCode: 99, reason: `agent.model invalid: ${errMsg(err)}` })
  }

  let litellm
  try { litellm = await startLitellmIfNeeded(model, cwd) } catch (err) {
    return finishFixCi({ exitCode: 99, reason: `litellm startup failed: ${errMsg(err)}` })
  }

  const prompt = buildFixCiPrompt({
    prNumber: opts.prNumber,
    prTitle: pr.title,
    featureBranch,
    workflowName,
    failedRunUrl,
    logTail,
    diff,
    conventionsBlock,
  })

  const ndjsonDir = path.join(cwd, ".kody2")
  const invokeAgent = async (p: string) =>
    runAgent({ prompt: p, model, cwd, litellmUrl: litellm?.url ?? null, verbose: opts.verbose, quiet: opts.quiet, ndjsonDir })

  let agentResult
  let parsed
  let coverageMisses: MissingTest[] = []
  try {
    agentResult = await invokeAgent(prompt)
    parsed = parseAgentResult(agentResult.finalText)

    const reqs = config.testRequirements ?? []
    if (parsed.done && reqs.length > 0) {
      coverageMisses = checkCoverage(getAddedFiles(config.git.defaultBranch, cwd), reqs)
      if (coverageMisses.length > 0) {
        const retryPrompt = `${prompt}\n\n# Coverage failure (retry)\n${formatMissesForFeedback(coverageMisses)}`
        const retry = await invokeAgent(retryPrompt)
        const retryParsed = parseAgentResult(retry.finalText)
        if (retry.outcome === "completed" && retryParsed.done) {
          agentResult = retry
          parsed = retryParsed
        }
        coverageMisses = checkCoverage(getAddedFiles(config.git.defaultBranch, cwd), reqs)
      }
    }
  } finally {
    try { litellm?.kill() } catch { /* best effort */ }
  }

  const agentOk = agentResult.outcome === "completed" && parsed.done && coverageMisses.length === 0

  let verifyOk = false
  let verifyReason = ""
  try {
    const v = await verifyAll(config, cwd)
    verifyOk = v.ok
    if (!v.ok) verifyReason = summarizeFailure(v)
  } catch (err) {
    verifyReason = `verify crashed: ${errMsg(err)}`
  }

  let commitResult
  try {
    commitResult = commitAndPush(featureBranch, parsed.commitMessage || `fix(ci): kody2 fix-ci for PR #${opts.prNumber}`, cwd)
  } catch (err) {
    const reason = `commit/push failed: ${errMsg(err)}`
    tryPostPr(opts.prNumber, `⚠️ kody2 fix-ci FAILED: ${truncate(reason, 1000)}`, cwd)
    return finishFixCi({ exitCode: 4, reason })
  }

  if (!commitResult.committed && !hasCommitsAhead(featureBranch, config.git.defaultBranch, cwd)) {
    const reason = "no changes committed — agent could not produce a fix"
    tryPostPr(opts.prNumber, `⚠️ kody2 fix-ci: ${reason}`, cwd)
    return finishFixCi({ exitCode: 3, reason })
  }

  const failureReason = !agentOk
    ? (parsed.failureReason || agentResult.error || "agent did not emit DONE")
    : !verifyOk ? verifyReason : ""

  const isFailure = failureReason !== ""
  const changedFiles = listChangedFiles(cwd).filter((f) => !isForbiddenPath(f))

  let prResult
  try {
    prResult = ensurePr({
      branch: featureBranch,
      defaultBranch: config.git.defaultBranch,
      issueNumber: opts.prNumber,
      issueTitle: pr.title,
      draft: isFailure,
      failureReason: failureReason || undefined,
      changedFiles,
      agentSummary: parsed.prSummary,
      cwd,
    })
  } catch (err) {
    const reason = `PR update failed: ${errMsg(err)}`
    tryPostPr(opts.prNumber, `⚠️ kody2 fix-ci FAILED: ${reason}`, cwd)
    return finishFixCi({ exitCode: 4, reason })
  }

  const successMsg = isFailure
    ? `⚠️ kody2 fix-ci FAILED: ${truncate(failureReason, 1500)} — PR: ${prResult.url}`
    : `✅ kody2 fix-ci applied: ${prResult.url}`
  tryPostPr(opts.prNumber, successMsg, cwd)

  let exitCode = 0
  if (!agentOk) exitCode = 1
  else if (!verifyOk) exitCode = 2
  return finishFixCi({ exitCode, prUrl: prResult.url, reason: failureReason || undefined })
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try { postPrReviewComment(prNumber, body, cwd) } catch { /* best effort */ }
}

function finishFixCi(r: FixCiResult): FixCiResult {
  if (r.prUrl) process.stdout.write(`PR_URL=${r.prUrl}\n`)
  else if (r.reason) process.stdout.write(`PR_URL=FAILED: ${r.reason}\n`)
  return r
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
