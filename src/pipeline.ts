import * as fs from "fs"
import * as path from "path"

import type {
  StageResult,
  PipelineStatus,
  PipelineContext,
} from "./types.js"
import { STAGES } from "./definitions.js"
import { ensureFeatureBranch, syncWithDefault } from "./git-utils.js"
import { setLifecycleLabel } from "./github-api.js"
import { logger, ciGroup, ciGroupEnd } from "./logger.js"
import { loadState, writeState, initState } from "./pipeline/state.js"
import { filterByComplexity } from "./pipeline/complexity.js"
import { getExecutor } from "./pipeline/executor-registry.js"
import {
  applyPreStageLabel,
  checkQuestionsAfterStage,
  autoDetectComplexity,
  checkRiskGate,
  commitAfterStage,
  postSkippedStagesComment,
} from "./pipeline/hooks.js"
import { autoLearn } from "./learning/auto-learn.js"
import { runRetrospective } from "./retrospective.js"

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureFeatureBranchIfNeeded(ctx: PipelineContext): void {
  if (!ctx.input.issueNumber || ctx.input.dryRun) return
  try {
    const taskMdPath = path.join(ctx.taskDir, "task.md")
    const title = fs.existsSync(taskMdPath)
      ? fs.readFileSync(taskMdPath, "utf-8").split("\n")[0].slice(0, 50)
      : ctx.taskId
    ensureFeatureBranch(ctx.input.issueNumber, title, ctx.projectDir)
    syncWithDefault(ctx.projectDir)
  } catch (err) {
    logger.warn(`  Failed to create/sync feature branch: ${err}`)
  }
}

// ─── Lock ───────────────────────────────────────────────────────────────────

function acquireLock(taskDir: string): void {
  const lockPath = path.join(taskDir, ".lock")
  if (fs.existsSync(lockPath)) {
    try {
      const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10)
      try { process.kill(pid, 0); throw new Error(`Pipeline already running (PID ${pid})`) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e
        // PID not alive — stale lock, safe to overwrite
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Pipeline already")) throw e
      // Corrupt lock file — overwrite
    }
  }
  fs.writeFileSync(lockPath, String(process.pid))
}

function releaseLock(taskDir: string): void {
  try { fs.unlinkSync(path.join(taskDir, ".lock")) } catch { /* ignore */ }
}

// ─── Pipeline Loop ──────────────────────────────────────────────────────────

export async function runPipeline(ctx: PipelineContext): Promise<PipelineStatus> {
  acquireLock(ctx.taskDir)
  try {
    return await runPipelineInner(ctx)
  } finally {
    releaseLock(ctx.taskDir)
  }
}

async function runPipelineInner(ctx: PipelineContext): Promise<PipelineStatus> {
  const pipelineStartTime = Date.now()
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

  if (ctx.input.issueNumber && !ctx.input.local) {
    const initialPhase = ctx.input.mode === "rerun" ? "building" : "planning"
    setLifecycleLabel(ctx.input.issueNumber, initialPhase)
  }

  ensureFeatureBranchIfNeeded(ctx)

  let complexity = ctx.input.complexity ?? "high"
  let activeStages = filterByComplexity(STAGES, complexity)
  let skippedStagesCommentPosted = false

  for (const def of STAGES) {
    // fromStage skip
    if (!startExecution) {
      if (def.name === fromStage) { startExecution = true } else { continue }
    }

    if (state.stages[def.name].state === "completed") {
      logger.info(`[${def.name}] already completed, skipping`)
      continue
    }

    // Complexity skip
    if (!activeStages.find((s) => s.name === def.name)) {
      logger.info(`[${def.name}] skipped (complexity: ${complexity})`)
      state.stages[def.name] = { state: "completed", retries: 0, outputFile: undefined }
      writeState(state, ctx.taskDir)
      if (!skippedStagesCommentPosted) {
        postSkippedStagesComment(ctx, complexity, activeStages)
        skippedStagesCommentPosted = true
      }
      continue
    }

    ciGroup(`Stage: ${def.name}`)

    state.stages[def.name] = { state: "running", startedAt: new Date().toISOString(), retries: 0 }
    writeState(state, ctx.taskDir)
    logger.info(`[${def.name}] starting...`)

    applyPreStageLabel(ctx, def)

    // Execute stage via registry
    let result: StageResult
    try {
      result = await getExecutor(def.name)(ctx, def)
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

      const paused = checkQuestionsAfterStage(ctx, def, state)
      if (paused) return paused

      const detected = autoDetectComplexity(ctx, def)
      if (detected) {
        complexity = detected.complexity
        activeStages = detected.activeStages
      }

      const gated = checkRiskGate(ctx, def, state, complexity)
      if (gated) return gated

      commitAfterStage(ctx, def)
    } else {
      // Failed or timed out
      const isTimeout = result.outcome === "timed_out"
      state.stages[def.name] = {
        state: isTimeout ? "timeout" : "failed",
        retries: result.retries,
        error: isTimeout ? "Stage timed out" : (result.error ?? "Stage failed"),
      }
      state.state = "failed"
      writeState(state, ctx.taskDir)
      logger.error(`[${def.name}] ${isTimeout ? "⏱ timed out" : `✗ failed: ${result.error}`}`)
      if (ctx.input.issueNumber && !ctx.input.local) {
        setLifecycleLabel(ctx.input.issueNumber, "failed")
      }
      break
    }

    writeState(state, ctx.taskDir)
  }

  const allCompleted = STAGES.every((s) => state.stages[s.name].state === "completed")
  if (allCompleted) {
    state.state = "completed"
    writeState(state, ctx.taskDir)
    logger.info(`Pipeline completed: ${ctx.taskId}`)
    if (ctx.input.issueNumber && !ctx.input.local) {
      setLifecycleLabel(ctx.input.issueNumber, "done")
    }
    autoLearn(ctx)
  }

  await runRetrospective(ctx, state, pipelineStartTime).catch(() => {})

  return state
}

// ─── Status Display ─────────────────────────────────────────────────────────

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
