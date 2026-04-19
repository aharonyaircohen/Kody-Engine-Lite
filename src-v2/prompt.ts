import type { KodyLeanConfig } from "./config.js"
import type { IssueData, IssueComment } from "./issue.js"

const COMMENT_MAX_BYTES = 4000
const COMMENT_LIMIT = 5

export interface BuildPromptOptions {
  config: KodyLeanConfig
  issue: IssueData
  featureBranch: string
}

export function buildPrompt(opts: BuildPromptOptions): string {
  const { config, issue, featureBranch } = opts
  const qualityLines: string[] = []
  if (config.quality.typecheck) qualityLines.push(`- typecheck: \`${config.quality.typecheck}\``)
  if (config.quality.testUnit) qualityLines.push(`- tests:     \`${config.quality.testUnit}\``)
  if (config.quality.lint) qualityLines.push(`- lint:      \`${config.quality.lint}\``)
  if (qualityLines.length === 0) qualityLines.push("- (no quality commands configured)")

  const commentsBlock = formatComments(issue.comments)

  return `You are Kody, an autonomous engineer. Take a GitHub issue from spec to a tested set of edits in ONE session. The wrapper handles git/gh — you do not.

# Repo
- ${config.github.owner}/${config.github.repo}, default branch: ${config.git.defaultBranch}
- current branch (already checked out): ${featureBranch}

# Issue #${issue.number}: ${issue.title}
${issue.body || "(no body)"}

${commentsBlock}

# Quality gates (MUST all pass)
${qualityLines.join("\n")}

# Required steps (all in this one session — no handoff)
1. **Research** — read the issue carefully. Use Grep/Glob/Read to investigate the codebase: locate relevant files, understand existing patterns, check related tests, identify constraints. Do not edit anything yet.
2. **Plan** — before any Edit/Write, output a short plan (5–10 lines): what files you'll change, the approach, what could go wrong. No fluff.
3. **Build** — Edit/Write to implement the change. Stay within the plan; if you discover the plan was wrong, briefly say so and adjust.
4. **Verify** — run each quality command with Bash. On failure, fix the root cause and re-run. When reporting that a command passed, you MUST have just run it and seen exit code 0 in this session — do not paraphrase prior output.
5. Your FINAL message must use this exact format (or a single \`FAILED: <reason>\` line on failure):

   \`\`\`
   DONE
   COMMIT_MSG: <conventional-commit message, e.g. "feat: add X" or "fix: handle Y">
   PR_SUMMARY:
   <2-6 short bullet points or sentences describing what you actually changed, why, and how the new code works at a high level. Reviewers will read THIS — not the issue body — to understand the change. Be concrete: name the files/functions/endpoints you added or modified. No marketing fluff. No restating the issue.>
   \`\`\`

# Rules
- Do NOT run **any** \`git\` or \`gh\` commands. Not for committing. Not for pushing. Not for inspecting state. Not for "verifying whether failures are pre-existing." Not stash, checkout, diff, status, log, branch — none. The wrapper handles all git/gh operations. If a quality gate fails, that's the failure — do not investigate it via git.
- Stay on the current branch (\`${featureBranch}\`). It is already checked out for you.
- Do NOT modify files under: \`.kody/\`, \`.kody-engine/\`, \`.kody-lean/\`, \`node_modules/\`, \`dist/\`, \`build/\`, \`.env\`, or any \`*.log\`.
- Do NOT post issue comments — the wrapper handles that.
- Pre-existing quality-gate failures: assume they are NOT your responsibility unless your edits touched related code. If quality gates are red but your edits are unrelated, output \`DONE\` with a COMMIT_MSG describing only what you actually changed.
- Keep the plan and reasoning concise. Long monologues waste turns.`
}

function formatComments(comments: IssueComment[]): string {
  if (comments.length === 0) return "Recent comments: (none)"
  const recent = comments.slice(-COMMENT_LIMIT).reverse()
  const lines = ["Recent comments (most recent first, truncated):"]
  for (const c of recent) {
    const body = c.body.length > COMMENT_MAX_BYTES
      ? c.body.slice(0, COMMENT_MAX_BYTES) + "… (truncated)"
      : c.body
    lines.push(`- [${c.author}] ${body.replace(/\n/g, " ")}`)
  }
  return lines.join("\n")
}

export interface ParsedAgentResult {
  done: boolean
  commitMessage: string
  prSummary: string
  failureReason: string
}

export function parseAgentResult(finalText: string): ParsedAgentResult {
  const text = (finalText || "").trim()
  if (!text) return { done: false, commitMessage: "", prSummary: "", failureReason: "agent produced no final message" }

  const failedMatch = text.match(/(?:^|\n)\s*FAILED\s*:\s*(.+?)\s*$/s)
  if (failedMatch) {
    return { done: false, commitMessage: "", prSummary: "", failureReason: failedMatch[1]!.trim() }
  }

  if (!/(^|\n)\s*DONE\b/i.test(text)) {
    return { done: false, commitMessage: "", prSummary: "", failureReason: "no DONE or FAILED marker in agent output" }
  }

  const commitMatch = text.match(/^[ \t]*COMMIT_MSG\s*:\s*(.+)$/im)
  const commitMessage = commitMatch ? commitMatch[1]!.trim() : ""

  // PR_SUMMARY: spans from the marker line to end-of-input (or to a closing ``` fence).
  const summaryStart = text.search(/(^|\n)[ \t]*PR_SUMMARY\s*:[ \t]*\n/i)
  let prSummary = ""
  if (summaryStart !== -1) {
    const afterMarker = text.slice(summaryStart).replace(/^[\s\S]*?PR_SUMMARY\s*:[ \t]*\n/i, "")
    prSummary = afterMarker.replace(/\n\s*```\s*$/g, "").replace(/```\s*$/g, "").trim()
  }

  return { done: true, commitMessage, prSummary, failureReason: "" }
}
