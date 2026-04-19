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
  getPrLatestReviewBody,
  postPrReviewComment,
  truncate,
} from "../issue.js"
import { loadProjectConventions, parseAgentResult } from "../prompt.js"
import { checkCoverage, getAddedFiles, formatMissesForFeedback, type MissingTest } from "../coverage.js"

const PR_DIFF_MAX_BYTES = 40_000

export interface FixOptions {
  prNumber: number
  feedback?: string
  cwd?: string
  verbose?: boolean
  quiet?: boolean
}

export interface FixResult {
  exitCode: number
  prUrl?: string
  reason?: string
}

function buildFixPrompt(args: {
  prNumber: number
  prTitle: string
  prBody: string
  feedback: string
  diff: string
  conventionsBlock: string
  coverageBlock: string
  featureBranch: string
}): string {
  return `You are Kody, an autonomous engineer. Apply the feedback below to the existing PR branch \`${args.featureBranch}\` (already checked out). The wrapper handles git/gh — you do not.

# PR #${args.prNumber}: ${args.prTitle}

${args.prBody || "(no description)"}

# Feedback to address (AUTHORITATIVE)

${args.feedback}

${args.conventionsBlock}${args.coverageBlock}# Existing diff (current PR state, truncated)

\`\`\`diff
${truncate(args.diff, PR_DIFF_MAX_BYTES)}
\`\`\`

# Required steps
1. Read the feedback carefully. It takes precedence over the original issue spec. If feedback says "remove X", remove X even if the issue asked for it.
2. Research ONLY what's needed to address the feedback.
3. Make the minimum edits required.
4. Run each quality command with Bash. Fix the root cause of any failure you introduced.
5. Final message format (or a single \`FAILED: <reason>\` line on failure):

   DONE
   COMMIT_MSG: <conventional-commit message for this round of fixes>
   PR_SUMMARY:
   <2-4 bullets describing what changed in THIS fix round, not the whole PR>

# Rules
- Do NOT run git/gh commands. Wrapper handles it.
- Stay on \`${args.featureBranch}\`.
- Do not modify files under \`.kody/\`, \`.kody-engine/\`, \`.kody2/\`, \`node_modules/\`, \`dist/\`, \`build/\`, \`.env\`, \`*.log\`.
- If the feedback is ambiguous or conflicts with the issue, err toward what the feedback says.`
}

export async function runFix(opts: FixOptions): Promise<FixResult> {
  const cwd = opts.cwd ?? process.cwd()

  let config: ReturnType<typeof loadConfig>
  try { config = loadConfig(cwd) } catch (err) {
    return finishFix({ exitCode: 99, reason: `config error: ${errMsg(err)}` })
  }

  let pr
  try { pr = getPr(opts.prNumber, cwd) } catch (err) {
    return finishFix({ exitCode: 99, reason: `failed to fetch PR #${opts.prNumber}: ${errMsg(err)}` })
  }
  if (pr.state !== "OPEN") {
    return finishFix({ exitCode: 1, reason: `PR #${opts.prNumber} is not OPEN (state: ${pr.state})` })
  }

  let featureBranch: string
  try {
    checkoutPrBranch(opts.prNumber, cwd)
    featureBranch = getCurrentBranch(cwd)
  } catch (err) {
    return finishFix({ exitCode: 99, reason: `failed to check out PR branch: ${errMsg(err)}` })
  }

  const feedback = (opts.feedback && opts.feedback.trim()) || getPrLatestReviewBody(opts.prNumber, cwd)
  if (!feedback.trim()) {
    return finishFix({ exitCode: 1, reason: "no --feedback provided and no review/body text found on PR" })
  }

  tryPostPr(opts.prNumber, `⚙️ kody2 fix started on \`${featureBranch}\` — applying feedback (${truncate(feedback.replace(/\n/g, " "), 200)})`, cwd)

  const diff = getPrDiff(opts.prNumber, cwd)
  const conventions = loadProjectConventions(cwd)
  const conventionsBlock = conventions.length > 0
    ? "# Project conventions (AUTHORITATIVE)\n\n" + conventions.map((c) => `## ${c.path}\n\n${c.content}\n\n`).join("") + "\n"
    : ""
  const coverageBlock = (config.testRequirements ?? []).length > 0
    ? formatCoverageBlock(config.testRequirements!)
    : ""

  let model
  try { model = parseProviderModel(config.agent.model) } catch (err) {
    return finishFix({ exitCode: 99, reason: `agent.model invalid: ${errMsg(err)}` })
  }

  let litellm
  try { litellm = await startLitellmIfNeeded(model, cwd) } catch (err) {
    return finishFix({ exitCode: 99, reason: `litellm startup failed: ${errMsg(err)}` })
  }

  const prompt = buildFixPrompt({
    prNumber: opts.prNumber,
    prTitle: pr.title,
    prBody: pr.body,
    feedback,
    diff,
    conventionsBlock,
    coverageBlock,
    featureBranch,
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
        process.stderr.write(`[kody2 fix] coverage check found ${coverageMisses.length} missing test(s); retrying agent once\n`)
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
    commitResult = commitAndPush(featureBranch, parsed.commitMessage || `chore(fix): kody2 fix for PR #${opts.prNumber}`, cwd)
  } catch (err) {
    const reason = `commit/push failed: ${errMsg(err)}`
    tryPostPr(opts.prNumber, `⚠️ kody2 fix FAILED: ${truncate(reason, 1000)}`, cwd)
    return finishFix({ exitCode: 4, reason })
  }

  if (!commitResult.committed && !hasCommitsAhead(featureBranch, config.git.defaultBranch, cwd)) {
    const reason = "no changes to commit"
    tryPostPr(opts.prNumber, `⚠️ kody2 fix: ${reason}. Feedback may already be satisfied or may not be actionable.`, cwd)
    return finishFix({ exitCode: 3, reason })
  }

  const failureReason = !agentOk
    ? (parsed.failureReason || agentResult.error || (coverageMisses.length > 0 ? `missing tests: ${coverageMisses.map((m) => m.expectedTest).join(", ")}` : "agent did not emit DONE"))
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
    tryPostPr(opts.prNumber, `⚠️ kody2 fix FAILED: ${reason}`, cwd)
    return finishFix({ exitCode: 4, reason })
  }

  const successMsg = isFailure
    ? `⚠️ kody2 fix FAILED: ${truncate(failureReason, 1500)} — PR: ${prResult.url}`
    : `✅ kody2 fix applied: ${prResult.url}`
  tryPostPr(opts.prNumber, successMsg, cwd)

  let exitCode = 0
  if (!agentOk) exitCode = 1
  else if (!verifyOk) exitCode = 2
  return finishFix({ exitCode, prUrl: prResult.url, reason: failureReason || undefined })
}

function formatCoverageBlock(reqs: { pattern: string; requireSibling: string }[]): string {
  const lines = [
    "# Test coverage requirements (ENFORCED)",
    "Every newly added file matching a pattern below MUST be accompanied by a sibling test in the same commit.",
  ]
  for (const r of reqs) lines.push(`- new \`${r.pattern}\` → must include sibling \`${r.requireSibling}\``)
  lines.push("")
  return lines.join("\n")
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try { postPrReviewComment(prNumber, body, cwd) } catch { /* best effort */ }
}

function finishFix(r: FixResult): FixResult {
  if (r.prUrl) process.stdout.write(`PR_URL=${r.prUrl}\n`)
  else if (r.reason) process.stdout.write(`PR_URL=FAILED: ${r.reason}\n`)
  return r
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
