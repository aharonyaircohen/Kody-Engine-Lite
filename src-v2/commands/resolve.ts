import * as path from "path"
import { execFileSync } from "child_process"
import { loadConfig, parseProviderModel } from "../config.js"
import { startLitellmIfNeeded } from "../litellm.js"
import { runAgent } from "../agent.js"
import { checkoutPrBranch, getCurrentBranch, mergeBase } from "../branch.js"
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
  postPrReviewComment,
  truncate,
} from "../issue.js"
import { loadProjectConventions, parseAgentResult } from "../prompt.js"

const CONFLICT_DIFF_MAX_BYTES = 40_000

export interface ResolveOptions {
  prNumber: number
  cwd?: string
  verbose?: boolean
  quiet?: boolean
}

export interface ResolveResult {
  exitCode: number
  prUrl?: string
  reason?: string
}

function getConflictedFiles(cwd?: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, HUSKY: "0" },
    }).trim()
    return out ? out.split("\n").filter(Boolean) : []
  } catch { return [] }
}

function getConflictMarkersPreview(files: string[], cwd?: string, maxBytes = CONFLICT_DIFF_MAX_BYTES): string {
  const chunks: string[] = []
  let total = 0
  for (const f of files) {
    try {
      const content = execFileSync("cat", [f], { encoding: "utf-8", cwd }).toString()
      const snippet = `### ${f}\n\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\`\n`
      total += snippet.length
      chunks.push(snippet)
      if (total >= maxBytes) break
    } catch { /* skip */ }
  }
  return chunks.join("\n")
}

function buildResolvePrompt(args: {
  prNumber: number
  prTitle: string
  baseBranch: string
  featureBranch: string
  conflictedFiles: string[]
  markersPreview: string
  conventionsBlock: string
}): string {
  return `You are Kody, an autonomous engineer. A \`git merge origin/${args.baseBranch}\` into PR #${args.prNumber} (\`${args.featureBranch}\`) produced conflicts. Resolve them. The wrapper handles git/gh — you do not.

# PR #${args.prNumber}: ${args.prTitle}

# Conflicted files (${args.conflictedFiles.length})
${args.conflictedFiles.map((f) => `- \`${f}\``).join("\n")}

${args.conventionsBlock}# Working-tree conflict markers (truncated)

${args.markersPreview}

# Required steps
1. For each conflicted file: read it, understand both sides of the \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers, and produce the correct merged content. Remove all conflict markers.
2. Preserve the PR's intent (the HEAD side) unless \`origin/${args.baseBranch}\` made a change that should be preserved (e.g. security fix, renamed API). Use judgement.
3. After resolving, run the quality commands with Bash and fix any issues YOUR resolution introduced.
4. Final message format (or \`FAILED: <reason>\` on failure):

   DONE
   COMMIT_MSG: fix: resolve merge conflicts with ${args.baseBranch}
   PR_SUMMARY:
   <2-4 bullets: which files had conflicts, how you resolved each, any judgement calls>

# Rules
- Do NOT run git/gh. Wrapper handles the merge commit.
- Do NOT delete files to "resolve" conflicts. Merge the content.
- Do NOT leave any \`<<<<<<<\`, \`=======\`, or \`>>>>>>>\` markers in files.
- Stay on \`${args.featureBranch}\`.`
}

export async function runResolve(opts: ResolveOptions): Promise<ResolveResult> {
  const cwd = opts.cwd ?? process.cwd()

  let config: ReturnType<typeof loadConfig>
  try { config = loadConfig(cwd) } catch (err) {
    return finishResolve({ exitCode: 99, reason: `config error: ${errMsg(err)}` })
  }

  let pr
  try { pr = getPr(opts.prNumber, cwd) } catch (err) {
    return finishResolve({ exitCode: 99, reason: `failed to fetch PR #${opts.prNumber}: ${errMsg(err)}` })
  }
  if (pr.state !== "OPEN") {
    return finishResolve({ exitCode: 1, reason: `PR #${opts.prNumber} is not OPEN (state: ${pr.state})` })
  }

  let featureBranch: string
  try {
    checkoutPrBranch(opts.prNumber, cwd)
    featureBranch = getCurrentBranch(cwd)
  } catch (err) {
    return finishResolve({ exitCode: 99, reason: `failed to check out PR branch: ${errMsg(err)}` })
  }

  const baseBranch = pr.baseRefName || config.git.defaultBranch
  const mergeStatus = mergeBase(baseBranch, cwd)

  if (mergeStatus === "clean") {
    const reason = `already up to date with origin/${baseBranch} — nothing to resolve`
    tryPostPr(opts.prNumber, `ℹ️ kody2 resolve: ${reason}`, cwd)
    return finishResolve({ exitCode: 0, reason })
  }
  if (mergeStatus === "error") {
    const reason = `failed to merge origin/${baseBranch} (non-conflict error); see runner log`
    tryPostPr(opts.prNumber, `⚠️ kody2 resolve FAILED: ${reason}`, cwd)
    return finishResolve({ exitCode: 99, reason })
  }

  const conflictedFiles = getConflictedFiles(cwd)
  if (conflictedFiles.length === 0) {
    return finishResolve({ exitCode: 99, reason: "merge reported conflict but no unmerged paths detected" })
  }

  tryPostPr(opts.prNumber, `⚙️ kody2 resolve started on \`${featureBranch}\` — ${conflictedFiles.length} conflicted file(s)`, cwd)

  const markersPreview = getConflictMarkersPreview(conflictedFiles, cwd)
  const conventions = loadProjectConventions(cwd)
  const conventionsBlock = conventions.length > 0
    ? "# Project conventions (AUTHORITATIVE)\n\n" + conventions.map((c) => `## ${c.path}\n\n${c.content}\n\n`).join("") + "\n"
    : ""

  let model
  try { model = parseProviderModel(config.agent.model) } catch (err) {
    return finishResolve({ exitCode: 99, reason: `agent.model invalid: ${errMsg(err)}` })
  }

  let litellm
  try { litellm = await startLitellmIfNeeded(model, cwd) } catch (err) {
    return finishResolve({ exitCode: 99, reason: `litellm startup failed: ${errMsg(err)}` })
  }

  const prompt = buildResolvePrompt({
    prNumber: opts.prNumber,
    prTitle: pr.title,
    baseBranch,
    featureBranch,
    conflictedFiles,
    markersPreview,
    conventionsBlock,
  })

  const ndjsonDir = path.join(cwd, ".kody2")
  let agentResult
  let parsed
  try {
    agentResult = await runAgent({
      prompt, model, cwd, litellmUrl: litellm?.url ?? null,
      verbose: opts.verbose, quiet: opts.quiet, ndjsonDir,
    })
    parsed = parseAgentResult(agentResult.finalText)
  } finally {
    try { litellm?.kill() } catch { /* best effort */ }
  }

  // Confirm no remaining conflict markers.
  const stillConflicted = getConflictedFiles(cwd)
  const agentOk = agentResult.outcome === "completed" && parsed.done && stillConflicted.length === 0

  let verifyOk = false
  let verifyReason = ""
  try {
    const v = await verifyAll(config, cwd)
    verifyOk = v.ok
    if (!v.ok) verifyReason = summarizeFailure(v)
  } catch (err) {
    verifyReason = `verify crashed: ${errMsg(err)}`
  }

  // Stage conflicted files explicitly so the merge can commit.
  try {
    execFileSync("git", ["add", "-A"], { cwd, env: { ...process.env, HUSKY: "0" }, stdio: "pipe" })
  } catch { /* best effort */ }

  let commitResult
  try {
    const msg = parsed.commitMessage || `fix: resolve merge conflicts with ${baseBranch}`
    commitResult = commitAndPush(featureBranch, msg, cwd)
  } catch (err) {
    const reason = `commit/push failed: ${errMsg(err)}`
    tryPostPr(opts.prNumber, `⚠️ kody2 resolve FAILED: ${truncate(reason, 1000)}`, cwd)
    return finishResolve({ exitCode: 4, reason })
  }

  if (!commitResult.committed && !hasCommitsAhead(featureBranch, config.git.defaultBranch, cwd)) {
    const reason = "no merge commit produced — agent may have left unresolved markers"
    tryPostPr(opts.prNumber, `⚠️ kody2 resolve: ${reason}`, cwd)
    return finishResolve({ exitCode: 3, reason })
  }

  const failureReason = !agentOk
    ? (parsed.failureReason || (stillConflicted.length > 0 ? `unresolved markers in: ${stillConflicted.join(", ")}` : (agentResult.error || "agent did not emit DONE")))
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
    tryPostPr(opts.prNumber, `⚠️ kody2 resolve FAILED: ${reason}`, cwd)
    return finishResolve({ exitCode: 4, reason })
  }

  const successMsg = isFailure
    ? `⚠️ kody2 resolve FAILED: ${truncate(failureReason, 1500)} — PR: ${prResult.url}`
    : `✅ kody2 resolve merged ${baseBranch} into \`${featureBranch}\`: ${prResult.url}`
  tryPostPr(opts.prNumber, successMsg, cwd)

  let exitCode = 0
  if (!agentOk) exitCode = 1
  else if (!verifyOk) exitCode = 2
  return finishResolve({ exitCode, prUrl: prResult.url, reason: failureReason || undefined })
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try { postPrReviewComment(prNumber, body, cwd) } catch { /* best effort */ }
}

function finishResolve(r: ResolveResult): ResolveResult {
  if (r.prUrl) process.stdout.write(`PR_URL=${r.prUrl}\n`)
  else if (r.reason) process.stdout.write(`PR_URL=FAILED: ${r.reason}\n`)
  return r
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
