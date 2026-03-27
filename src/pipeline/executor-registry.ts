import type { StageName, StageDefinition, StageResult, PipelineContext } from "../types.js"
import { executeAgentStage } from "../stages/agent.js"
import { executeVerifyWithAutofix } from "../stages/verify.js"
import { executeReviewWithFix } from "../stages/review.js"
import { executeShipStage } from "../stages/ship.js"

export type StageExecutor = (
  ctx: PipelineContext,
  def: StageDefinition,
) => StageResult | Promise<StageResult>

const EXECUTOR_REGISTRY: Record<StageName, StageExecutor> = {
  taskify: executeAgentStage,
  plan: executeAgentStage,
  build: executeAgentStage,
  verify: executeVerifyWithAutofix,
  review: executeReviewWithFix,
  "review-fix": executeAgentStage,
  ship: executeShipStage,
}

export function getExecutor(name: StageName): StageExecutor {
  const executor = EXECUTOR_REGISTRY[name]
  if (!executor) {
    throw new Error(`No executor registered for stage: ${name}`)
  }
  return executor
}
