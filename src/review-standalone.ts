import * as fs from "fs"
import * as path from "path"

import type { AgentRunner } from "./types.js"
import { STAGES } from "./definitions.js"
import { executeAgentStage } from "./stages/agent.js"
import { generateTaskId } from "./cli/task-resolution.js"
import { logger } from "./logger.js"
import { getDiffFiles } from "./git-utils.js"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StandaloneReviewInput {
  projectDir: string
  runners: Record<string, AgentRunner>
  prTitle: string
  prBody: string
  baseBranch?: string
  local: boolean
  taskId?: string
}

export interface StandaloneReviewResult {
  outcome: "completed" | "failed"
  reviewContent?: string
  taskDir?: string
  error?: string
}

export interface PRInfo {
  number: number
  title: string
  url: string
  headBranch: string
}

export type ReviewTargetResult =
  | { action: "review"; prNumber: number }
  | { action: "pick"; prs: PRInfo[]; message: string }
  | { action: "none"; message: string }

// ─── Multi-PR Resolution ────────────────────────────────────────────────────

export function resolveReviewTarget(input: {
  issueNumber: number
  prs: PRInfo[]
}): ReviewTargetResult {
  if (input.prs.length === 0) {
    return {
      action: "none",
      message: `Issue #${input.issueNumber} has no open PRs. Nothing to review.`,
    }
  }

  if (input.prs.length === 1) {
    return { action: "review", prNumber: input.prs[0].number }
  }

  const prList = input.prs
    .map((pr) => `  - #${pr.number}: ${pr.title}`)
    .join("\n")

  return {
    action: "pick",
    prs: input.prs,
    message: `⚠️ Issue #${input.issueNumber} has ${input.prs.length} open PRs:\n${prList}\n\nRun: \`pnpm kody review --pr-number <n>\`\nOr comment on the specific PR: \`@kody review\``,
  }
}

// ─── Standalone Review Execution ────────────────────────────────────────────

export async function runStandaloneReview(
  input: StandaloneReviewInput,
): Promise<StandaloneReviewResult> {
  const taskId = input.taskId ?? `review-${generateTaskId()}`
  const taskDir = path.join(input.projectDir, ".kody", "tasks", taskId)
  fs.mkdirSync(taskDir, { recursive: true })

  // Write task.md from PR info, including diff instructions for the review agent
  let diffInstruction = ""
  let filesChangedSection = ""
  if (input.baseBranch) {
    diffInstruction = `\n\n## Diff Command\nRun: \`git diff origin/${input.baseBranch}...HEAD\` to see the PR changes.\nDo NOT use bare \`git diff\` — it shows only uncommitted working tree changes, not the PR diff.`

    const diffFiles = getDiffFiles(input.baseBranch, input.projectDir)
    if (diffFiles.length > 0) {
      logger.info(`[review] Review scope: git diff origin/${input.baseBranch}...HEAD (${diffFiles.length} files)`)
      const fileList = diffFiles.map((f) => `- ${f}`).join("\n")
      filesChangedSection = `\n\n## Files Changed\nOnly review the following ${diffFiles.length} files (these are the files changed in this PR):\n${fileList}`
    } else {
      logger.info(`[review] Review scope: git diff origin/${input.baseBranch}...HEAD (0 files)`)
    }
  } else {
    logger.warn(`[review] No baseBranch provided — reviewing all files (no diff scope)`)
  }
  const taskContent = `# ${input.prTitle}\n\n${input.prBody ?? ""}${diffInstruction}${filesChangedSection}`
  fs.writeFileSync(path.join(taskDir, "task.md"), taskContent)

  const reviewDef = STAGES.find((s) => s.name === "review")!

  const ctx = {
    taskId,
    taskDir,
    projectDir: input.projectDir,
    runners: input.runners,
    sessions: {} as Record<string, string>,
    input: {
      mode: "full" as const,
      local: input.local,
    },
  }

  logger.info(`[review] standalone review for: ${input.prTitle}`)

  const result = await executeAgentStage(ctx, reviewDef)

  if (result.outcome !== "completed") {
    return {
      outcome: "failed",
      taskDir,
      error: result.error ?? "Review stage failed",
    }
  }

  // Read review.md
  const reviewPath = path.join(taskDir, "review.md")
  let reviewContent: string | undefined
  if (fs.existsSync(reviewPath)) {
    reviewContent = fs.readFileSync(reviewPath, "utf-8")
  }

  return {
    outcome: "completed",
    reviewContent,
    taskDir,
  }
}

// ─── Verdict Detection ─────────────────────────────────────────────────────

export function detectReviewVerdict(reviewContent: string): "pass" | "fail" {
  // Look for "Verdict: FAIL" or "Verdict: PASS" in the review content
  const verdictMatch = reviewContent.match(/##\s*Verdict:\s*(PASS|FAIL)/i)
  if (verdictMatch) {
    return verdictMatch[1].toLowerCase() as "pass" | "fail"
  }
  // Fallback: if there are critical or major findings, treat as fail
  const hasCritical = /###\s*Critical\s*\n(?!None\.)/i.test(reviewContent)
  const hasMajor = /###\s*Major\s*\n(?!None\.)/i.test(reviewContent)
  if (hasCritical || hasMajor) return "fail"
  return "pass"
}

// ─── Output Formatting ─────────────────────────────────────────────────────

export function formatReviewComment(
  reviewContent: string,
  taskId: string,
): string {
  const verdict = detectReviewVerdict(reviewContent)
  const cta = verdict === "fail"
    ? "\n\n> To fix these issues, comment: `@kody fix`\n> The review findings will be used automatically as context."
    : ""
  return `## 🔍 Kody Review (\`${taskId}\`)\n\n${reviewContent}${cta}\n\n---\n🤖 Generated by Kody`
}
