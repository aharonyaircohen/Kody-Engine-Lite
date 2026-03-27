import * as fs from "fs"
import * as path from "path"

import type {
  StageDefinition,
  StageResult,
  PipelineContext,
} from "../types.js"
import { buildFullPrompt, resolveModel } from "../context.js"
import { validateTaskJson, validatePlanMd, validateReviewMd } from "../validators.js"
import { getProjectConfig } from "../config.js"
import { getRunnerForStage } from "../pipeline/runner-selection.js"
import { logger } from "../logger.js"

function validateStageOutput(
  stageName: string,
  content: string,
): { valid: boolean; error?: string } {
  switch (stageName) {
    case "taskify":
      return validateTaskJson(content)
    case "plan":
      return validatePlanMd(content)
    case "review":
      return validateReviewMd(content)
    default:
      return { valid: true }
  }
}

export async function executeAgentStage(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const prompt = buildFullPrompt(def.name, ctx.taskId, ctx.taskDir, ctx.projectDir, ctx.input.feedback)
  const model = resolveModel(def.modelTier, def.name)

  const config = getProjectConfig()
  const runnerName =
    config.agent.stageRunners?.[def.name] ??
    config.agent.defaultRunner ??
    Object.keys(ctx.runners)[0] ?? "claude"

  logger.info(`  runner=${runnerName} model=${model} timeout=${def.timeout / 1000}s`)

  const extraEnv: Record<string, string> = {}
  if (config.agent.litellmUrl) {
    extraEnv.ANTHROPIC_BASE_URL = config.agent.litellmUrl
  }

  const runner = getRunnerForStage(ctx, def.name)
  const result = await runner.run(def.name, prompt, model, def.timeout, ctx.taskDir, {
    cwd: ctx.projectDir,
    env: extraEnv,
  })

  if (result.outcome !== "completed") {
    return { outcome: result.outcome, error: result.error, retries: 0 }
  }

  if (def.outputFile && result.output) {
    fs.writeFileSync(path.join(ctx.taskDir, def.outputFile), result.output)
  }

  // Variant file detection: if expected file missing, look for <base>-*<ext> variants
  if (def.outputFile) {
    const outputPath = path.join(ctx.taskDir, def.outputFile)
    if (!fs.existsSync(outputPath)) {
      const ext = path.extname(def.outputFile)
      const base = path.basename(def.outputFile, ext)
      const files = fs.readdirSync(ctx.taskDir)
      const variant = files.find(
        (f) => f.startsWith(base + "-") && f.endsWith(ext),
      )
      if (variant) {
        fs.renameSync(path.join(ctx.taskDir, variant), outputPath)
        logger.info(`  Renamed variant ${variant} → ${def.outputFile}`)
      }
    }
  }

  if (def.outputFile) {
    const outputPath = path.join(ctx.taskDir, def.outputFile)
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, "utf-8")
      const validation = validateStageOutput(def.name, content)
      if (!validation.valid) {
        logger.warn(`  validation warning: ${validation.error}`)
      }
    }
  }

  return { outcome: "completed", outputFile: def.outputFile, retries: 0 }
}
