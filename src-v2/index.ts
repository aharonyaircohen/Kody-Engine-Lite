import * as path from "path"
import { loadConfig, parseProviderModel } from "./config.js"
import { startLitellmIfNeeded } from "./litellm.js"
import { ensureFeatureBranch, UncommittedChangesError } from "./branch.js"
import { commitAndPush, hasCommitsAhead, listChangedFiles, isForbiddenPath } from "./commit.js"
import { ensurePr } from "./pr.js"
import { verifyAll, summarizeFailure } from "./verify.js"
import { getIssue, postIssueComment, truncate } from "./issue.js"
import { buildPrompt, parseAgentResult, loadProjectConventions } from "./prompt.js"
import { runAgent } from "./agent.js"

export interface RunOptions {
  issueNumber: number
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  dryRun?: boolean
}

export interface RunResult {
  exitCode: number
  prUrl?: string
  reason?: string
}

const RUN_URL = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : ""

export async function run(opts: RunOptions): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd()
  const issueNumber = opts.issueNumber

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(cwd)
  } catch (err) {
    return finish({ exitCode: 99, reason: `config error: ${errMsg(err)}` })
  }

  let issue
  try {
    issue = getIssue(issueNumber, cwd)
  } catch (err) {
    return finish({ exitCode: 99, reason: `failed to fetch issue #${issueNumber}: ${errMsg(err)}` })
  }

  let branchInfo
  try {
    branchInfo = ensureFeatureBranch(issueNumber, issue.title, config.git.defaultBranch, cwd)
  } catch (err) {
    if (err instanceof UncommittedChangesError) {
      const reason = err.message
      tryPost(issueNumber, `⚠️ kody2 refused to start: ${reason}`, cwd)
      return finish({ exitCode: 5, reason })
    }
    return finish({ exitCode: 99, reason: `branch setup failed: ${errMsg(err)}` })
  }

  const startMsg = RUN_URL
    ? `⚙️ kody2 started — branch \`${branchInfo.branch}\`, run ${RUN_URL}`
    : `⚙️ kody2 started — branch \`${branchInfo.branch}\``
  tryPost(issueNumber, startMsg, cwd)

  if (opts.dryRun) {
    return finish({ exitCode: 0, reason: "dry-run: prompt assembled, agent skipped" })
  }

  let model
  try {
    model = parseProviderModel(config.agent.model)
  } catch (err) {
    return finishWithDraftPr({
      cwd,
      branch: branchInfo.branch,
      defaultBranch: config.git.defaultBranch,
      issueNumber,
      issueTitle: issue.title,
      reason: `agent.model invalid: ${errMsg(err)}`,
      exitCode: 99,
    })
  }

  let litellm
  try {
    litellm = await startLitellmIfNeeded(model, cwd)
  } catch (err) {
    return finishWithDraftPr({
      cwd,
      branch: branchInfo.branch,
      defaultBranch: config.git.defaultBranch,
      issueNumber,
      issueTitle: issue.title,
      reason: `litellm startup failed: ${errMsg(err)}`,
      exitCode: 99,
    })
  }

  const conventions = loadProjectConventions(cwd)
  if (conventions.length > 0) {
    process.stderr.write(`[kody-lean] loaded conventions: ${conventions.map((c) => c.path).join(", ")}\n`)
  }
  const prompt = buildPrompt({ config, issue, featureBranch: branchInfo.branch, conventions })

  const ndjsonDir = path.join(cwd, ".kody-lean")
  let agentResult
  try {
    agentResult = await runAgent({
      prompt,
      model,
      cwd,
      litellmUrl: litellm?.url ?? null,
      verbose: opts.verbose,
      quiet: opts.quiet,
      ndjsonDir,
    })
  } finally {
    try { litellm?.kill() } catch { /* best effort */ }
  }

  const parsed = parseAgentResult(agentResult.finalText)
  const agentOk = agentResult.outcome === "completed" && parsed.done

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
    commitResult = commitAndPush(branchInfo.branch, parsed.commitMessage || `chore: kody2 changes for #${issueNumber}`, cwd)
  } catch (err) {
    return finishWithDraftPr({
      cwd,
      branch: branchInfo.branch,
      defaultBranch: config.git.defaultBranch,
      issueNumber,
      issueTitle: issue.title,
      reason: `commit/push failed: ${errMsg(err)}`,
      exitCode: 4,
    })
  }

  const ahead = hasCommitsAhead(branchInfo.branch, config.git.defaultBranch, cwd)
  if (!commitResult.committed && !ahead) {
    const reason = "no changes to commit"
    tryPost(issueNumber, `⚠️ kody2 FAILED: ${reason}`, cwd)
    return finish({ exitCode: 3, reason })
  }

  const failureReason = !agentOk
    ? (parsed.failureReason || agentResult.error || "agent did not emit DONE")
    : !verifyOk
      ? verifyReason
      : ""

  const isFailure = failureReason !== ""
  const changedFiles = listChangedFiles(cwd).filter((f) => !isForbiddenPath(f))

  let prResult
  try {
    prResult = ensurePr({
      branch: branchInfo.branch,
      defaultBranch: config.git.defaultBranch,
      issueNumber,
      issueTitle: issue.title,
      draft: isFailure,
      failureReason: failureReason || undefined,
      changedFiles,
      agentSummary: parsed.prSummary,
      cwd,
    })
  } catch (err) {
    const reason = `PR creation failed: ${errMsg(err)}`
    tryPost(issueNumber, `⚠️ kody2 FAILED: ${reason}`, cwd)
    return finish({ exitCode: 4, reason })
  }

  const successMsg = isFailure
    ? `⚠️ kody2 FAILED: ${truncate(failureReason, 1500)} — draft PR: ${prResult.url}`
    : `✅ kody2 PR opened: ${prResult.url}`
  tryPost(issueNumber, successMsg, cwd)

  let exitCode = 0
  if (!agentOk) exitCode = 1
  else if (!verifyOk) exitCode = 2
  return finish({ exitCode, prUrl: prResult.url, reason: failureReason || undefined })
}

function finish(r: RunResult): RunResult {
  if (r.prUrl) process.stdout.write(`PR_URL=${r.prUrl}\n`)
  else if (r.reason) process.stdout.write(`PR_URL=FAILED: ${r.reason}\n`)
  return r
}

interface DraftPrInputs {
  cwd: string
  branch: string
  defaultBranch: string
  issueNumber: number
  issueTitle: string
  reason: string
  exitCode: number
}

function finishWithDraftPr(inputs: DraftPrInputs): RunResult {
  let prUrl: string | undefined
  try {
    const ahead = hasCommitsAhead(inputs.branch, inputs.defaultBranch, inputs.cwd)
    if (ahead) {
      const result = ensurePr({
        branch: inputs.branch,
        defaultBranch: inputs.defaultBranch,
        issueNumber: inputs.issueNumber,
        issueTitle: inputs.issueTitle,
        draft: true,
        failureReason: inputs.reason,
        changedFiles: [],
        cwd: inputs.cwd,
      })
      prUrl = result.url
    }
  } catch { /* best effort */ }

  const msg = prUrl
    ? `⚠️ kody2 FAILED: ${truncate(inputs.reason, 1500)} — draft PR: ${prUrl}`
    : `⚠️ kody2 FAILED: ${truncate(inputs.reason, 1500)}`
  tryPost(inputs.issueNumber, msg, inputs.cwd)
  return finish({ exitCode: inputs.exitCode, prUrl, reason: inputs.reason })
}

function tryPost(issueNumber: number, body: string, cwd?: string): void {
  try { postIssueComment(issueNumber, body, cwd) } catch { /* best effort */ }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
