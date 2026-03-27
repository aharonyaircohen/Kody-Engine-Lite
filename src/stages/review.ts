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

export async function executeReviewWithFix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    return { outcome: "completed", retries: 0 }
  }

  const reviewDef = STAGES.find((s) => s.name === "review")!
  const reviewFixDef = STAGES.find((s) => s.name === "review-fix")!

  const reviewResult = await executeAgentStage(ctx, reviewDef)
  if (reviewResult.outcome !== "completed") {
    return reviewResult
  }

  const reviewFile = path.join(ctx.taskDir, "review.md")
  if (!fs.existsSync(reviewFile)) {
    return { outcome: "failed", retries: 0, error: "review.md not found" }
  }

  const content = fs.readFileSync(reviewFile, "utf-8")
  const hasIssues = /\bfail\b/i.test(content) && !/pass/i.test(content)

  if (!hasIssues) {
    return reviewResult
  }

  logger.info(`  review found issues, running review-fix...`)
  const fixResult = await executeAgentStage(ctx, reviewFixDef)
  if (fixResult.outcome !== "completed") {
    return fixResult
  }

  logger.info(`  re-running review after fix...`)
  return executeAgentStage(ctx, reviewDef)
}
