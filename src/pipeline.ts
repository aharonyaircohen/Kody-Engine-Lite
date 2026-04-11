import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import type {
  StageResult,
  PipelineStatus,
  PipelineContext,
} from "./types.js"
import { STAGES } from "./definitions.js"
import { ensureFeatureBranch, syncWithDefault } from "./git-utils.js"
import { setLifecycleLabel, setLabel, postComment } from "./github-api.js"
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
import { nudge } from "./memory/nudge.js"
import { runRetrospective } from "./retrospective.js"
import { formatPipelineSummary } from "./pipeline/summary.js"
import { getProjectConfig } from "./config.js"
import { runToolSetup } from "./tools.js"
import { appendRunRecord, readRunHistory } from "./run-history.js"
import type { RunRecord } from "./run-history.js"
import { emit } from "./event-system/index.js"

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureFeatureBranchIfNeeded(ctx: PipelineContext): void {
  if (ctx.input.dryRun) return

  // PR-based fix/rerun: workflow already checked out the PR branch,
  // but we still merge latest default to avoid building on stale code.
  // Use the PR's actual base branch (not config default) to avoid pulling
  // unrelated changes from a different branch (e.g. kody vs dev).
  if (ctx.input.prNumber) {
    try {
      syncWithDefault(ctx.projectDir, ctx.input.prBaseBranch)
    } catch (err) {
      logger.warn(`  Failed to sync with default branch: ${err}`)
    }
    return
  }

  if (!ctx.input.issueNumber) return
  try {
    const taskMdPath = path.join(ctx.taskDir, "task.md")
    const title = fs.existsSync(taskMdPath)
      ? fs.readFileSync(taskMdPath, "utf-8").split("\n")[0].slice(0, 50)
      : ctx.taskId
    ensureFeatureBranch(ctx.input.issueNumber, title, ctx.projectDir)
    syncWithDefault(ctx.projectDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Feature branch creation is critical for issue-based runs — pipeline
    // would commit to the wrong branch without it. Throw to abort, unless
    // we're not in a git repo at all (e.g., test environment).
    if (msg.includes("not a git repository")) {
      logger.warn(`  Not a git repository — skipping feature branch setup`)
    } else {
      logger.error(`  Failed to create/sync feature branch: ${msg}`)
      throw new Error(`Feature branch setup failed: ${msg}`)
    }
  }
}

// ─── Lock ───────────────────────────────────────────────────────────────────

function acquireLock(taskDir: string): void {
  const lockPath = path.join(taskDir, ".lock")

  // Check for existing lock and stale PID
  if (fs.existsSync(lockPath)) {
    try {
      const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10)
      if (!isNaN(pid)) {
        try { process.kill(pid, 0); throw new Error(`Pipeline already running (PID ${pid})`) } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e
          // PID not alive — stale lock, safe to overwrite
          logger.info(`  Removing stale lock (PID ${pid} no longer running)`)
        }
      } else {
        logger.warn(`  Corrupt lock file (non-numeric PID) — overwriting`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Pipeline already")) throw e
      logger.warn(`  Corrupt lock file — overwriting`)
    }
    // Remove stale/corrupt lock before creating new one
    try { fs.unlinkSync(lockPath) } catch { /* may already be removed */ }
  }

  // Atomic lock creation using O_EXCL (fails if file exists — prevents TOCTOU race)
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL)
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Pipeline already running (lock acquired by another process)")
    }
    throw err
  }
}

function releaseLock(taskDir: string): void {
  try { fs.unlinkSync(path.join(taskDir, ".lock")) } catch { /* ignore */ }
}

// ─── Graph Memory Commit ─────────────────────────────────────────────────────

/**
 * Commit any uncommitted graph memory changes to git.
 * Runs after the full pipeline (including nudge) so all episode writes are included.
 */
function commitGraphMemory(ctx: PipelineContext): void {
  if (ctx.input.dryRun) return

  try {
    const graphDir = path.join(ctx.projectDir, ".kody", "graph")
    if (!fs.existsSync(graphDir)) return

    const env = { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" }

    // Check for uncommitted changes
    const status = execFileSync("git", ["status", "--porcelain", ".kody/graph/"], {
      cwd: ctx.projectDir,
      encoding: "utf-8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (!status.trim()) return

    execFileSync("git", ["add", ".kody/graph/"], {
      cwd: ctx.projectDir,
      env,
      stdio: "pipe",
    })
    execFileSync("git", ["commit", "--no-gpg-sign", "-m", `chore: update graph memory [skip ci]`], {
      cwd: ctx.projectDir,
      env,
      stdio: "pipe",
    })
    logger.info("  Committed graph memory")
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)
    logger.info(`  Graph commit skipped: ${msg}`)
  }
}

// ─── Pipeline Loop ──────────────────────────────────────────────────────────

export async function runPipeline(ctx: PipelineContext): Promise<PipelineStatus> {
  acquireLock(ctx.taskDir)
  try {
    return await runPipelineInner(ctx)
  } catch (err) {
    // Ensure state is set to "failed" on unexpected crash — prevents
    // stale "running" state that blocks subsequent commands.
    try {
      const state = loadState(ctx.taskId, ctx.taskDir)
      if (state && state.state === "running") {
        // Build updated stages immutably
        const updatedStages = { ...state.stages }
        for (const stage of STAGES) {
          if (updatedStages[stage.name]?.state === "running") {
            updatedStages[stage.name] = {
              ...updatedStages[stage.name],
              state: "failed",
              error: "Pipeline crashed unexpectedly",
            }
          }
        }
        writeState({ ...state, state: "failed", stages: updatedStages }, ctx.taskDir)
      }
    } catch { /* best effort */ }
    throw err
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

  // Restore sessions from state (for reruns) and share with context
  ctx.sessions = state.sessions ?? {}

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

  // Emit pipeline.started event
  emit("pipeline.started", { runId: ctx.taskId, issueNumber: ctx.input.issueNumber }).catch((err) =>
    logger.debug(`[event] pipeline.started error: ${err}`),
  )

  ensureFeatureBranchIfNeeded(ctx)

  if (ctx.tools?.length) {
    ciGroup("Tool Setup")
    runToolSetup(ctx.tools, ctx.projectDir)
    ciGroupEnd()
  }

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

    // Run autoLearn before ship so memory updates are included in the commit
    if (def.name === "ship") {
      autoLearn(ctx)
    }

    ciGroup(`Stage: ${def.name}`)

    state.stages[def.name] = { state: "running", startedAt: new Date().toISOString(), retries: 0 }
    writeState(state, ctx.taskDir)
    logger.info(`[${def.name}] starting...`)

    applyPreStageLabel(ctx, def)

    emit("step.started", { runId: ctx.taskId, step: def.name }).catch((err) =>
      logger.debug(`[event] step.started error: ${err}`),
    )

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
        promptTokens: result.promptTokens,
      }
      logger.info(`[${def.name}] ✓ completed`)

      emit("step.complete", { runId: ctx.taskId, step: def.name }).catch((err) =>
        logger.debug(`[event] step.complete error: ${err}`),
      )

      // Detect complexity BEFORE checking questions — otherwise question
      // gate pauses the pipeline before risk_level is ever read from task.json,
      // preventing the risk gate from firing on HIGH-complexity tasks.
      const detected = autoDetectComplexity(ctx, def)
      if (detected) {
        complexity = detected.complexity
        activeStages = detected.activeStages
      }

      const paused = checkQuestionsAfterStage(ctx, def, state)
      if (paused) {
        emit("step.waiting", { runId: ctx.taskId, step: def.name, context: { reason: "questions" } }).catch((err) =>
          logger.debug(`[event] step.waiting error: ${err}`),
        )
        return paused
      }

      const gated = checkRiskGate(ctx, def, state, complexity)
      if (gated) {
        emit("step.waiting", { runId: ctx.taskId, step: def.name, context: { reason: "risk-gate" } }).catch((err) =>
          logger.debug(`[event] step.waiting error: ${err}`),
        )
        return gated
      }

      commitAfterStage(ctx, def)
    } else {
      // Failed or timed out
      const isTimeout = result.outcome === "timed_out"
      state.stages[def.name] = {
        state: isTimeout ? "timeout" : "failed",
        retries: result.retries,
        error: isTimeout ? "Stage timed out" : (result.error ?? "Stage failed"),
        promptTokens: result.promptTokens,
      }
      state.state = "failed"
      state.sessions = ctx.sessions
      writeState(state, ctx.taskDir)
      logger.error(`[${def.name}] ${isTimeout ? "⏱ timed out" : `✗ failed: ${result.error}`}`)
      emit("step.failed", { runId: ctx.taskId, step: def.name, error: isTimeout ? "Stage timed out" : result.error }).catch((err) =>
        logger.debug(`[event] step.failed error: ${err}`),
      )
      if (ctx.input.issueNumber && !ctx.input.local) {
        setLabel(ctx.input.issueNumber, "kody:failed")
      }
      break
    }

    state.sessions = ctx.sessions
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
    emit("pipeline.success", { runId: ctx.taskId, issueNumber: ctx.input.issueNumber }).catch((err) =>
      logger.debug(`[event] pipeline.success error: ${err}`),
    )
  } else {
    emit("pipeline.failed", { runId: ctx.taskId, error: "Stage failed", issueNumber: ctx.input.issueNumber }).catch((err) =>
      logger.debug(`[event] pipeline.failed error: ${err}`),
    )
  }

  await runRetrospective(ctx, state, pipelineStartTime).catch((err) => {
    logger.warn(`  Retrospective failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Memory nudge: LLM-driven pattern extraction from successful runs
  if (state.state === "completed") {
    await nudge(ctx).catch((err) => {
      logger.warn(`  Nudge failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  // Commit graph memory after all writes (including retrospective + nudge)
  commitGraphMemory(ctx)

  // Record run history for cross-run context
  const issueForHistory = ctx.input.issueNumber ?? ctx.input.linkedIssue
  if (issueForHistory) {
    try {
      const failedEntry = Object.entries(state.stages).find(
        ([, s]) => s.state === "failed" || s.state === "timeout",
      )
      const completedStages = Object.entries(state.stages)
        .filter(([, s]) => s.state === "completed")
        .map(([name]) => name)

      const commandMap: Record<string, string> = { full: "run", rerun: "rerun" }
      const command = commandMap[ctx.input.mode] ?? ctx.input.mode

      // For reruns, stages before fromStage stay "pending" — that's not a failure.
      // The run succeeded if no stage failed/timed-out.
      const hasFailure = !!failedEntry
      const outcome = hasFailure ? "failed" : "completed"

      const runRecord: RunRecord = {
        runId: ctx.taskId,
        issueNumber: ctx.input.issueNumber,
        prNumber: ctx.input.prNumber,
        command,
        startedAt: state.createdAt,
        completedAt: new Date().toISOString(),
        outcome,
        failedStage: failedEntry?.[0],
        failedError: failedEntry?.[1].error?.slice(0, 200),
        stagesCompleted: completedStages,
        feedback: ctx.input.feedback?.slice(0, 200),
        parentRunId: ctx.input.parentRunId,
        linkedIssue: ctx.input.linkedIssue,
      }
      appendRunRecord(ctx.projectDir, runRecord)
    } catch (err) {
      logger.warn(`  Run history recording failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Post pipeline summary comment on the issue
  if (ctx.input.issueNumber && !ctx.input.dryRun) {
    const config = getProjectConfig()
    const isCI = !!process.env.GITHUB_ACTIONS
    const shouldPost = config.github.postSummary ?? (isCI ? true : false)
    if (shouldPost) {
      try {
        const summaryOpts: { complexity?: string; model?: string; runCount?: number } = {}
        if (complexity) summaryOpts.complexity = complexity
        const modelMap = config.agent?.modelMap
        if (modelMap?.mid) summaryOpts.model = modelMap.mid
        // Include run count from history
        const historyRecords = readRunHistory(ctx.projectDir, ctx.input.issueNumber)
        if (historyRecords.length > 0) summaryOpts.runCount = historyRecords.length
        const summary = formatPipelineSummary(state, summaryOpts)
        postComment(ctx.input.issueNumber, summary)
        logger.info("Pipeline summary posted on issue")
      } catch (err) {
        logger.warn(`  Failed to post pipeline summary: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return state
}

// ─── Status Display ─────────────────────────────────────────────────────────

/**
 * Format and return task status as a string.
 * Also prints to stdout for CLI usage.
 */
export function formatStatus(taskId: string, taskDir: string, projectDir?: string, issueNumber?: number): string | null {
  const state = loadState(taskId, taskDir)
  if (!state) return null

  const lines: string[] = []
  lines.push(`**Task:** \`${state.taskId}\``)
  lines.push(`**State:** ${state.state}`)
  lines.push(`**Created:** ${state.createdAt}`)
  lines.push(`**Updated:** ${state.updatedAt}`, "")

  for (const stage of STAGES) {
    const s = state.stages[stage.name]
    const icon =
      s.state === "completed" ? "✅" :
      s.state === "failed" ? "❌" :
      s.state === "running" ? "▶️" :
      s.state === "timeout" ? "⏱" : "○"
    const extra = s.error ? ` — ${s.error}` : ""
    lines.push(`${icon} ${stage.name}: ${s.state}${extra}`)
  }

  // Show run history timeline if available
  if (projectDir && issueNumber) {
    const records = readRunHistory(projectDir, issueNumber)
    if (records.length > 0) {
      lines.push("", `**Run History for Issue #${issueNumber}:**`)
      for (let i = 0; i < records.length; i++) {
        const r = records[i]
        const date = r.startedAt.split("T")[0]
        const failInfo = r.failedStage ? ` (failed at ${r.failedStage})` : ""
        const current = r.runId === taskId ? " ← current" : ""
        lines.push(`  #${i + 1}  \`${r.runId}\`  ${r.command}  ${r.outcome.padEnd(10)}  ${date}${failInfo}${current}`)
      }
    }
  }

  return lines.join("\n")
}

/** Legacy: prints status to stdout. Calls formatStatus internally. */
export function printStatus(taskId: string, taskDir: string, projectDir?: string, issueNumber?: number): void {
  const text = formatStatus(taskId, taskDir, projectDir, issueNumber)
  if (!text) {
    console.log(`No status found for task ${taskId}`)
    return
  }
  console.log("\n" + text)
}
