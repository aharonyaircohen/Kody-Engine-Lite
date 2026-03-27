import type { PipelineContext, AgentRunner } from "../types.js"
import { getProjectConfig } from "../config.js"

export function getRunnerForStage(
  ctx: PipelineContext,
  stageName: string,
): AgentRunner {
  const config = getProjectConfig()
  const runnerName =
    config.agent.stageRunners?.[stageName] ??
    config.agent.defaultRunner ??
    Object.keys(ctx.runners)[0] ??
    "claude"
  const runner = ctx.runners[runnerName]
  if (!runner) {
    throw new Error(
      `Runner "${runnerName}" not found for stage ${stageName}. Available: ${Object.keys(ctx.runners).join(", ")}`,
    )
  }
  return runner
}
