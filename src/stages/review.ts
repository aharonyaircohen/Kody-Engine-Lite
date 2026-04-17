import * as fs from "fs"
import * as path from "path"

import type {
  StageDefinition,
  StageResult,
  PipelineContext,
} from "../types.js"
import { STAGES } from "../definitions.js"
import { logger } from "../logger.js"
import { executeAgentStage } from "./agent.js"
import { detectReviewVerdict, formatReviewComment } from "../review-standalone.js"
import { createEpisode } from "../memory/graph/index.js"
import { inferRoom, writeFactOrSupersede } from "../memory/graph/index.js"
import { defaultConfidenceFor } from "../memory/graph/confidence.js"
import { postPRComment } from "../github-api.js"

const MAX_REVIEW_FIX_ITERATIONS = 2

// ─── Graph Memory Wiring ────────────────────────────────────────────────────────

interface TaskJson {
  scope?: string[]
  title?: string
  task_type?: string
}

/**
 * Extract convention facts from review content and write them to the graph.
 *
 * Scans for patterns like:
 *   - "Uses <Tool>" / "follows <Convention>"
 *   - Testing, lint, and code-quality notes
 *   - Summary bullets that describe project conventions
 *
 * One fact is written per review (deduplicated by content), in the "conventions" hall.
 */
function writeReviewConventions(
  projectDir: string,
  taskDir: string,
  reviewContent: string,
  taskId: string,
): void {
  const facts: string[] = []

  // Look for summary bullets that describe conventions
  const summaryMatch = reviewContent.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n## |\n*$)/)
  if (summaryMatch) {
    for (const line of summaryMatch[1].split("\n")) {
      const bullet = line.replace(/^[-*]\s*/, "").trim()
      if (
        bullet.length > 10 &&
        bullet.length < 200 &&
        !bullet.toLowerCase().includes("fail") &&
        !bullet.toLowerCase().includes("error") &&
        !bullet.toLowerCase().includes("missing") &&
        !bullet.toLowerCase().includes("should fix")
      ) {
        facts.push(bullet)
      }
    }
  }

  // Look for convention keywords in the review
  const conventionPatterns = [
    /uses?\s+(vitest|jest|mocha|playwright|testing[- ]library)/gi,
    /uses?\s+(eslint|prettier|husky|lint-staged)/gi,
    /uses?\s+(typescript|javascript|python|go|rust)/gi,
    /follows?\s+(conventional commits|trunk[- ]based)/gi,
    /tested (with|using)\s+([^\n.]{5,60})/gi,
  ]
  for (const pattern of conventionPatterns) {
    const match = reviewContent.match(pattern)
    if (match) {
      facts.push(match[0].replace(/\s+/g, " ").trim())
    }
  }

  if (facts.length === 0) return

  // Create a review episode
  const episode = createEpisode(projectDir, {
    runId: taskId,
    source: "review",
    taskId: String(taskId),
    createdAt: new Date().toISOString(),
    rawContent: reviewContent.slice(0, 1000),
    extractedNodeIds: [],
  })

  // Read scope from task.json for room inference
  let scope: string[] = []
  const taskJsonPath = path.join(taskDir, "task.json")
  if (fs.existsSync(taskJsonPath)) {
    try {
      const raw = fs.readFileSync(taskJsonPath, "utf-8")
      const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
      const parsed = JSON.parse(cleaned) as TaskJson
      scope = parsed.scope ?? []
    } catch {
      // Ignore parse errors
    }
  }

  const room = inferRoom(scope)

  const writtenIds: string[] = []
  for (const fact of facts) {
    const outcome = writeFactOrSupersede(
      projectDir,
      "conventions",
      room,
      fact,
      episode.id,
      undefined,
      defaultConfidenceFor("review"),
    )
    if (outcome.kind !== "skipped") writtenIds.push(outcome.next.id)
  }

  if (writtenIds.length > 0) {
    logger.info(
      `Wrote ${writtenIds.length} convention(s) to graph (room=${room}, episode=${episode.id})`,
    )
  }
}

export async function executeReviewWithFix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    return { outcome: "completed", retries: 0 }
  }

  const reviewDef = STAGES.find((s) => s.name === "review")!
  const reviewFixDef = STAGES.find((s) => s.name === "review-fix")!

  // Track final review content so we can write facts after the loop
  let finalReviewContent = ""
  let finalReviewResult: StageResult | null = null
  let finalRetries = 0

  for (let iteration = 0; iteration <= MAX_REVIEW_FIX_ITERATIONS; iteration++) {
    const label = iteration === 0 ? "initial review" : `review after fix #${iteration}`
    logger.info(`  running ${label}...`)

    const reviewResult = await executeAgentStage(ctx, reviewDef)
    if (reviewResult.outcome !== "completed") {
      return reviewResult
    }

    const reviewFile = path.join(ctx.taskDir, "review.md")
    if (!fs.existsSync(reviewFile)) {
      return { outcome: "failed", retries: iteration, error: "review.md not found" }
    }

    const content = fs.readFileSync(reviewFile, "utf-8")
    finalReviewContent = content
    finalReviewResult = reviewResult
    finalRetries = iteration

    if (detectReviewVerdict(content) !== "fail") {
      break // Review passed — exit loop
    }

    // Last iteration — no more fix attempts allowed
    if (iteration === MAX_REVIEW_FIX_ITERATIONS) {
      logger.warn(`  review still failing after ${MAX_REVIEW_FIX_ITERATIONS} fix attempts`)
      break // Exit loop, write facts with failing verdict
    }

    logger.info(`  review found issues (iteration ${iteration + 1}/${MAX_REVIEW_FIX_ITERATIONS}), running review-fix...`)
    const fixResult = await executeAgentStage(ctx, reviewFixDef)
    if (fixResult.outcome !== "completed") {
      return fixResult
    }
  }

  // Write review conventions to the graph (non-blocking — don't fail the stage on errors)
  if (finalReviewContent && finalReviewResult?.outcome === "completed") {
    try {
      writeReviewConventions(ctx.projectDir, ctx.taskDir, finalReviewContent, ctx.taskId)
    } catch (err) {
      logger.warn(`  Graph write failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Post review to PR
    if (ctx.input.prNumber && !ctx.input.local) {
      try {
        const comment = formatReviewComment(finalReviewContent, ctx.taskId)
        postPRComment(ctx.input.prNumber, comment)
        logger.info(`  Review posted to PR #${ctx.input.prNumber}`)
      } catch (err) {
        logger.warn(`  Failed to post review to PR: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (!finalReviewResult) {
    return { outcome: "failed", retries: finalRetries, error: "Unexpected review-fix loop exit" }
  }
  return { ...finalReviewResult, retries: finalRetries }
}
