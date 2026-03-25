import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import type {
  StageName,
  StageDefinition,
  StageResult,
  StageState,
  PipelineStatus,
  PipelineContext,
} from "./types.js"
import { STAGES } from "./definitions.js"
import { readPromptFile, injectTaskContext, resolveModel } from "./context.js"
import { validateTaskJson, validatePlanMd, validateReviewMd } from "./validators.js"
import { runQualityGates } from "./verify-runner.js"
import { getProjectConfig, FIX_COMMAND_TIMEOUT_MS } from "./config.js"
import { logger, ciGroup, ciGroupEnd } from "./logger.js"

// ─── State Management ────────────────────────────────────────────────────────

function loadState(taskId: string, taskDir: string): PipelineStatus | null {
  const p = path.join(taskDir, "status.json")
  if (!fs.existsSync(p)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"))
    if (raw.taskId === taskId) return raw as PipelineStatus
    return null
  } catch {
    return null
  }
}

function writeState(state: PipelineStatus, taskDir: string): void {
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(
    path.join(taskDir, "status.json"),
    JSON.stringify(state, null, 2),
  )
}

function initState(taskId: string): PipelineStatus {
  const stages = {} as Record<StageName, StageState>
  for (const stage of STAGES) {
    stages[stage.name] = { state: "pending", retries: 0 }
  }
  const now = new Date().toISOString()
  return { taskId, state: "running", stages, createdAt: now, updatedAt: now }
}

// ─── Validation ──────────────────────────────────────────────────────────────

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

// ─── Stage Execution ─────────────────────────────────────────────────────────

async function executeAgentStage(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const promptTemplate = readPromptFile(def.name)
  const prompt = injectTaskContext(promptTemplate, ctx.taskId, ctx.taskDir)
  const model = resolveModel(def.modelTier)

  logger.info(`  model=${model} timeout=${def.timeout / 1000}s`)

  const result = await ctx.runner.run(def.name, prompt, model, def.timeout, ctx.taskDir, {
    cwd: ctx.projectDir,
  })

  if (result.outcome !== "completed") {
    return { outcome: result.outcome, error: result.error, retries: 0 }
  }

  if (def.outputFile && result.output) {
    fs.writeFileSync(path.join(ctx.taskDir, def.outputFile), result.output)
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

function executeGateStage(
  ctx: PipelineContext,
  def: StageDefinition,
): StageResult {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const verifyResult = runQualityGates(ctx.taskDir, ctx.projectDir)

  const lines: string[] = [
    `# Verification Report\n`,
    `## Result: ${verifyResult.pass ? "PASS" : "FAIL"}\n`,
  ]
  if (verifyResult.errors.length > 0) {
    lines.push(`\n## Errors\n`)
    for (const e of verifyResult.errors) {
      lines.push(`- ${e}\n`)
    }
  }
  if (verifyResult.summary.length > 0) {
    lines.push(`\n## Summary\n`)
    for (const s of verifyResult.summary) {
      lines.push(`- ${s}\n`)
    }
  }

  fs.writeFileSync(path.join(ctx.taskDir, "verify.md"), lines.join(""))

  return {
    outcome: verifyResult.pass ? "completed" : "failed",
    retries: 0,
  }
}

async function executeVerifyWithAutofix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  const maxAttempts = def.maxRetries ?? 2

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    logger.info(`  verification attempt ${attempt + 1}/${maxAttempts + 1}`)

    const gateResult = executeGateStage(ctx, def)
    if (gateResult.outcome === "completed") {
      return { ...gateResult, retries: attempt }
    }

    if (attempt < maxAttempts) {
      logger.info(`  verification failed, running fixes...`)
      const config = getProjectConfig()

      const runFix = (cmd: string) => {
        if (!cmd) return
        const parts = cmd.split(/\s+/)
        try {
          execFileSync(parts[0], parts.slice(1), {
            stdio: "pipe",
            timeout: FIX_COMMAND_TIMEOUT_MS,
          })
        } catch {
          // Silently ignore fix failures
        }
      }

      runFix(config.quality.lintFix)
      runFix(config.quality.formatFix)

      if (def.retryWithAgent) {
        logger.info(`  running ${def.retryWithAgent} agent...`)
        await executeAgentStage(ctx, {
          ...def,
          name: def.retryWithAgent as StageName,
          type: "agent",
          modelTier: "mid",
          timeout: 300_000,
          outputFile: undefined,
        })
      }
    }
  }

  return {
    outcome: "failed",
    retries: maxAttempts,
    error: "Verification failed after autofix attempts",
  }
}

async function executeReviewWithFix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
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

function executeShipStage(
  ctx: PipelineContext,
  _def: StageDefinition,
): StageResult {
  // Phase 3 stub — real implementation in Phase 6
  const shipPath = path.join(ctx.taskDir, "ship.md")
  fs.writeFileSync(shipPath, "# Ship\n\nShip stage skipped — no git integration yet.\n")
  return { outcome: "completed", outputFile: "ship.md", retries: 0 }
}

// ─── Pipeline Loop ───────────────────────────────────────────────────────────

export async function runPipeline(ctx: PipelineContext): Promise<PipelineStatus> {
  let state = loadState(ctx.taskId, ctx.taskDir)

  if (!state) {
    state = initState(ctx.taskId)
    writeState(state, ctx.taskDir)
  }

  // Reset for rerun
  if (state.state !== "running") {
    state.state = "running"
    for (const stage of STAGES) {
      const s = state.stages[stage.name]
      if (s.state === "running" || s.state === "failed" || s.state === "timeout") {
        state.stages[stage.name] = { ...s, state: "pending" }
      }
    }
    writeState(state, ctx.taskDir)
  }

  const fromStage = ctx.input.fromStage
  let startExecution = !fromStage

  logger.info(`Pipeline started: ${ctx.taskId}`)
  logger.info(`Stages: ${STAGES.map((s) => s.name).join(" → ")}`)
  if (fromStage) logger.info(`Resuming from: ${fromStage}`)

  for (const def of STAGES) {
    // Handle fromStage skip logic
    if (!startExecution) {
      if (def.name === fromStage) {
        startExecution = true
      } else {
        continue
      }
    }

    if (state.stages[def.name].state === "completed") {
      logger.info(`[${def.name}] already completed, skipping`)
      continue
    }

    ciGroup(`Stage: ${def.name}`)

    state.stages[def.name] = {
      state: "running",
      startedAt: new Date().toISOString(),
      retries: 0,
    }
    writeState(state, ctx.taskDir)

    logger.info(`[${def.name}] starting...`)

    let result: StageResult

    try {
      if (def.type === "agent") {
        if (def.name === "review") {
          result = await executeReviewWithFix(ctx, def)
        } else {
          result = await executeAgentStage(ctx, def)
        }
      } else if (def.type === "gate") {
        if (def.name === "verify") {
          result = await executeVerifyWithAutofix(ctx, def)
        } else {
          result = executeGateStage(ctx, def)
        }
      } else if (def.type === "deterministic") {
        result = executeShipStage(ctx, def)
      } else {
        result = { outcome: "failed", retries: 0, error: `Unknown stage type: ${def.type}` }
      }
    } catch (error) {
      result = {
        outcome: "failed",
        retries: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    ciGroupEnd()

    if (result.outcome === "completed") {
      state.stages[def.name] = {
        state: "completed",
        completedAt: new Date().toISOString(),
        retries: result.retries,
        outputFile: result.outputFile,
      }
      logger.info(`[${def.name}] ✓ completed`)
    } else if (result.outcome === "timed_out") {
      state.stages[def.name] = {
        state: "timeout",
        retries: result.retries,
        error: "Stage timed out",
      }
      state.state = "failed"
      writeState(state, ctx.taskDir)
      logger.error(`[${def.name}] ⏱ timed out`)
      break
    } else {
      state.stages[def.name] = {
        state: "failed",
        retries: result.retries,
        error: result.error ?? "Stage failed",
      }
      state.state = "failed"
      writeState(state, ctx.taskDir)
      logger.error(`[${def.name}] ✗ failed: ${result.error}`)
      break
    }

    writeState(state, ctx.taskDir)
  }

  const allCompleted = STAGES.every(
    (s) => state.stages[s.name].state === "completed",
  )
  if (allCompleted) {
    state.state = "completed"
    writeState(state, ctx.taskDir)
    logger.info(`Pipeline completed: ${ctx.taskId}`)
  }

  return state
}

export function printStatus(taskId: string, taskDir: string): void {
  const state = loadState(taskId, taskDir)
  if (!state) {
    console.log(`No status found for task ${taskId}`)
    return
  }

  console.log(`\nTask: ${state.taskId}`)
  console.log(`State: ${state.state}`)
  console.log(`Created: ${state.createdAt}`)
  console.log(`Updated: ${state.updatedAt}\n`)

  for (const stage of STAGES) {
    const s = state.stages[stage.name]
    const icon =
      s.state === "completed" ? "✓" :
      s.state === "failed" ? "✗" :
      s.state === "running" ? "▶" :
      s.state === "timeout" ? "⏱" : "○"
    const extra = s.error ? ` — ${s.error}` : ""
    console.log(`  ${icon} ${stage.name}: ${s.state}${extra}`)
  }
}
