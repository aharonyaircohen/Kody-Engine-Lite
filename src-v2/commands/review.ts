import * as path from "path"
import { loadConfig, parseProviderModel } from "../config.js"
import { startLitellmIfNeeded } from "../litellm.js"
import { runAgent } from "../agent.js"
import { checkoutPrBranch } from "../branch.js"
import {
  getPr,
  getPrDiff,
  postPrReviewComment,
  postIssueComment,
  truncate,
} from "../issue.js"
import { loadProjectConventions } from "../prompt.js"

const REVIEW_TOOLS = ["Read", "Grep", "Glob", "Bash"]
const PR_DIFF_MAX_BYTES = 60_000

export interface ReviewOptions {
  prNumber: number
  cwd?: string
  verbose?: boolean
  quiet?: boolean
}

export interface ReviewResult {
  exitCode: number
  commentPosted: boolean
  reviewBody: string
  reason?: string
}

function buildReviewPrompt(args: {
  prNumber: number
  title: string
  body: string
  baseRef: string
  headRef: string
  diff: string
  conventionsBlock: string
}): string {
  const diffClipped = truncate(args.diff, PR_DIFF_MAX_BYTES)
  return `You are Kody, a senior code reviewer. Review PR #${args.prNumber} carefully and post ONE structured review comment. Do NOT edit any files. Do NOT run git or gh commands. Use Read/Grep/Glob/Bash only to inspect the diff and surrounding code.

# PR #${args.prNumber}: ${args.title}
Base: ${args.baseRef} ← Head: ${args.headRef}

${args.body || "(no description)"}

${args.conventionsBlock}# Diff (truncated to ~60KB)

\`\`\`diff
${diffClipped}
\`\`\`

# Required output

Your FINAL message must be a markdown-formatted review comment, structured like this:

\`\`\`
## Verdict: PASS | CONCERNS | FAIL

### Summary
<2-3 sentences: what this PR does, is the approach sound>

### Strengths
- <bullet>
- <bullet>

### Concerns
- <bullet, or "None" if none>

### Suggestions
- <bullet with file:line reference where possible>

### Bottom line
<one sentence>
\`\`\`

Nothing else. No DONE marker, no COMMIT_MSG, no PR_SUMMARY — the entire final message IS the review comment and will be posted verbatim.

# Rules
- No file edits. No git/gh. Read-only investigation.
- Be specific: cite file paths and line numbers. Don't write generic advice.
- Verdict FAIL only for clear correctness/security/regression risks.
- Verdict CONCERNS for style/clarity/test-coverage gaps.
- Verdict PASS when the PR meets spec with no blocking issues.`
}

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const cwd = opts.cwd ?? process.cwd()

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(cwd)
  } catch (err) {
    return { exitCode: 99, commentPosted: false, reviewBody: "", reason: `config error: ${errMsg(err)}` }
  }

  let pr
  try {
    pr = getPr(opts.prNumber, cwd)
  } catch (err) {
    return { exitCode: 99, commentPosted: false, reviewBody: "", reason: `failed to fetch PR #${opts.prNumber}: ${errMsg(err)}` }
  }

  if (pr.state !== "OPEN") {
    return {
      exitCode: 1,
      commentPosted: false,
      reviewBody: "",
      reason: `PR #${opts.prNumber} is not OPEN (state: ${pr.state})`,
    }
  }

  try {
    checkoutPrBranch(opts.prNumber, cwd)
  } catch (err) {
    return { exitCode: 99, commentPosted: false, reviewBody: "", reason: `failed to check out PR branch: ${errMsg(err)}` }
  }

  const diff = getPrDiff(opts.prNumber, cwd)
  const conventions = loadProjectConventions(cwd)
  const conventionsBlock = conventions.length > 0
    ? conventions.map((c) => `# ${c.path}\n\n${c.content}\n\n`).join("")
    : ""

  const prompt = buildReviewPrompt({
    prNumber: opts.prNumber,
    title: pr.title,
    body: pr.body,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    diff,
    conventionsBlock,
  })

  let model
  try { model = parseProviderModel(config.agent.model) } catch (err) {
    return { exitCode: 99, commentPosted: false, reviewBody: "", reason: `agent.model invalid: ${errMsg(err)}` }
  }

  let litellm
  try {
    litellm = await startLitellmIfNeeded(model, cwd)
  } catch (err) {
    return { exitCode: 99, commentPosted: false, reviewBody: "", reason: `litellm startup failed: ${errMsg(err)}` }
  }

  const ndjsonDir = path.join(cwd, ".kody2")
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
      allowedToolsOverride: REVIEW_TOOLS,
    })
  } finally {
    try { litellm?.kill() } catch { /* best effort */ }
  }

  if (agentResult.outcome !== "completed") {
    const reason = agentResult.error || "agent did not complete"
    tryPost(opts.prNumber, `⚠️ kody2 review FAILED: ${truncate(reason, 1000)}`, cwd)
    return { exitCode: 1, commentPosted: false, reviewBody: "", reason }
  }

  const reviewBody = agentResult.finalText.trim()
  if (!reviewBody) {
    tryPost(opts.prNumber, `⚠️ kody2 review FAILED: agent produced no review body`, cwd)
    return { exitCode: 1, commentPosted: false, reviewBody: "", reason: "empty review body" }
  }

  postPrReviewComment(opts.prNumber, reviewBody, cwd)
  process.stdout.write(`\nREVIEW_POSTED=https://github.com/${config.github.owner}/${config.github.repo}/pull/${opts.prNumber}\n`)
  return { exitCode: 0, commentPosted: true, reviewBody }
}

function tryPost(prNumber: number, body: string, cwd?: string): void {
  try { postIssueComment(prNumber, body, cwd) } catch { /* best effort */ }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
