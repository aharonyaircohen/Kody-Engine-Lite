import * as fs from "fs"
import * as path from "path"

import type { PipelineContext, DecomposeOutput } from "../types.js"
import { buildFullPrompt, resolveModel } from "../context.js"
import { getProjectConfig, resolveStageConfig, stageNeedsProxy, getLitellmUrl } from "../config.js"
import { validateDecomposeJson, stripFences } from "../validators.js"
import { getRunnerForStage } from "../pipeline/runner-selection.js"
import { logger } from "../logger.js"

const DECOMPOSE_TIMEOUT = 120_000 // 2 minutes

export async function executeDecompose(
  ctx: PipelineContext,
): Promise<DecomposeOutput | null> {
  const config = getProjectConfig()
  const minScore = config.decompose?.minComplexityScore ?? 4

  try {
    const prompt = buildFullPrompt("decompose", ctx.taskId, ctx.taskDir, ctx.projectDir, ctx.input.feedback, ctx.input.issueNumber)
    const sc = resolveStageConfig(config, "decompose", "cheap")
    const model = sc.model
    const useProxy = stageNeedsProxy(sc)

    const extraEnv: Record<string, string> = {}
    if (useProxy) {
      extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
    }

    const runner = getRunnerForStage(ctx, "taskify") // use cheap model runner
    logger.info(`  decompose: model=${model} timeout=${DECOMPOSE_TIMEOUT / 1000}s`)

    const result = await runner.run("decompose", prompt, model, DECOMPOSE_TIMEOUT, ctx.taskDir, {
      cwd: ctx.projectDir,
      env: extraEnv,
    })

    if (result.outcome !== "completed" || !result.output) {
      logger.warn(`  decompose agent failed: ${result.error ?? "no output"}`)
      return null
    }

    // Validate output
    const validation = validateDecomposeJson(result.output)
    if (!validation.valid) {
      logger.warn(`  decompose output invalid: ${validation.error}`)
      return null
    }

    const parsed: DecomposeOutput = JSON.parse(stripFences(result.output))

    // Write artifact
    fs.writeFileSync(path.join(ctx.taskDir, "decompose.json"), JSON.stringify(parsed, null, 2))

    // Check complexity threshold
    if (parsed.complexity_score < minScore) {
      logger.info(`  complexity_score ${parsed.complexity_score} < threshold ${minScore} — skipping decompose`)
      return { ...parsed, decomposable: false, reason: `Score ${parsed.complexity_score} below threshold ${minScore}` }
    }

    if (!parsed.decomposable) {
      logger.info(`  decompose: not decomposable — ${parsed.reason}`)
    } else {
      logger.info(`  decompose: ${parsed.sub_tasks.length} sub-tasks (score: ${parsed.complexity_score})`)
    }

    return parsed
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`  decompose failed: ${msg}`)
    return null
  }
}
