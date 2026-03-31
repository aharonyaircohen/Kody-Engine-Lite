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
import { detectReviewVerdict } from "../review-standalone.js"

const MAX_REVIEW_FIX_ITERATIONS = 2

export async function executeReviewWithFix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    return { outcome: "completed", retries: 0 }
  }

  const reviewDef = STAGES.find((s) => s.name === "review")!
  const reviewFixDef = STAGES.find((s) => s.name === "review-fix")!

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
    if (detectReviewVerdict(content) !== "fail") {
      return { ...reviewResult, retries: iteration }
    }

    // Last iteration — no more fix attempts allowed
    if (iteration === MAX_REVIEW_FIX_ITERATIONS) {
      logger.warn(`  review still failing after ${MAX_REVIEW_FIX_ITERATIONS} fix attempts`)
      return { ...reviewResult, retries: iteration }
    }

    logger.info(`  review found issues (iteration ${iteration + 1}/${MAX_REVIEW_FIX_ITERATIONS}), running review-fix...`)
    const fixResult = await executeAgentStage(ctx, reviewFixDef)
    if (fixResult.outcome !== "completed") {
      return fixResult
    }
  }

  // Should not reach here, but satisfy TypeScript
  return { outcome: "failed", retries: MAX_REVIEW_FIX_ITERATIONS, error: "Unexpected review-fix loop exit" }
}
