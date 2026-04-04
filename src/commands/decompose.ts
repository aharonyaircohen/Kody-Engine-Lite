import * as fs from "fs"
import * as path from "path"

import type {
  PipelineContext,
  AgentRunner,
  DecomposeOutput,
  DecomposeState,
  SubPipelineResult,
} from "../types.js"
import { STAGES } from "../definitions.js"
import { getProjectConfig } from "../config.js"
import { executeAgentStage } from "../stages/agent.js"
import { executeDecompose } from "../stages/decompose.js"
import { runSubPipelinesParallel } from "../pipeline/sub-pipeline.js"
import { ensureFeatureBranch, getCurrentBranch, commitAll } from "../git-utils.js"
import { createWorktree, cleanupWorktrees, worktreePath, getWorktreeChangedFiles } from "../worktree.js"
import { runCompose } from "./compose.js"
import { logger } from "../logger.js"

export interface DecomposeOptions {
  issueNumber: number
  projectDir: string
  runners: Record<string, AgentRunner>
  taskId: string
  taskDir: string
  local?: boolean
  autoCompose?: boolean
}

function loadDecomposeState(taskDir: string): DecomposeState | null {
  const statePath = path.join(taskDir, "decompose-state.json")
  if (!fs.existsSync(statePath)) return null
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"))
  } catch {
    return null
  }
}

function saveDecomposeState(taskDir: string, state: DecomposeState): void {
  fs.writeFileSync(
    path.join(taskDir, "decompose-state.json"),
    JSON.stringify(state, null, 2),
  )
}

export async function runDecompose(opts: DecomposeOptions): Promise<DecomposeState> {
  const { issueNumber, projectDir, runners, taskId, taskDir, autoCompose = true } = opts
  const config = getProjectConfig()

  // Check if decompose is disabled
  if (config.decompose?.enabled === false) {
    logger.info("  decompose disabled in config — falling back to normal pipeline")
    return fallbackToPipeline(opts)
  }

  // Build the context for running stages
  const ctx: PipelineContext = {
    taskId,
    taskDir,
    projectDir,
    runners,
    sessions: {},
    input: {
      mode: "full",
      issueNumber,
      local: opts.local,
    },
  }

  // ─── ANALYZE PHASE ──────────────────────────────────────────────────────────

  // 1a. Run taskify → task.json
  logger.info("Phase 1: Analyze")
  const taskifyDef = STAGES.find((s) => s.name === "taskify")!
  const taskifyResult = await executeAgentStage(ctx, taskifyDef)
  if (taskifyResult.outcome !== "completed") {
    logger.error(`  taskify failed: ${taskifyResult.error}`)
    return fallbackToPipeline(opts)
  }

  // 1b. Check risk_level — if "low", skip decompose
  const taskJsonPath = path.join(taskDir, "task.json")
  if (fs.existsSync(taskJsonPath)) {
    try {
      const taskJson = JSON.parse(fs.readFileSync(taskJsonPath, "utf-8"))
      if (taskJson.risk_level === "low") {
        logger.info("  risk_level=low — falling back to normal pipeline")
        return fallbackToPipeline(opts)
      }
    } catch { /* continue */ }
  }

  // 1c. Run plan → plan.md
  const planDef = STAGES.find((s) => s.name === "plan")!
  const planResult = await executeAgentStage(ctx, planDef)
  if (planResult.outcome !== "completed") {
    logger.error(`  plan failed: ${planResult.error}`)
    return fallbackToPipeline(opts)
  }

  // 1d. Run decompose agent
  const decomposeOutput = await executeDecompose(ctx)
  if (!decomposeOutput || !decomposeOutput.decomposable) {
    const reason = decomposeOutput?.reason ?? "decompose agent failed"
    logger.info(`  Not decomposable: ${reason} — falling back to normal pipeline`)
    return fallbackToPipeline(opts)
  }

  logger.info(`  Decomposed into ${decomposeOutput.sub_tasks.length} sub-tasks (score: ${decomposeOutput.complexity_score})`)

  // ─── PARALLEL BUILD PHASE ──────────────────────────────────────────────────

  logger.info("Phase 2: Parallel Build")

  // Read the full plan for slicing
  const planPath = path.join(taskDir, "plan.md")
  const fullPlan = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf-8") : ""

  // Read task title for branch naming
  let taskTitle = "decompose"
  const taskMdPath = path.join(taskDir, "task.md")
  if (fs.existsSync(taskMdPath)) {
    const content = fs.readFileSync(taskMdPath, "utf-8")
    const heading = content.split("\n").find((l) => l.startsWith("# "))
    if (heading) taskTitle = heading.replace(/^#\s*/, "").trim()
  }

  // Ensure feature branch
  const featureBranch = ensureFeatureBranch(issueNumber, taskTitle, projectDir)
  logger.info(`  Feature branch: ${featureBranch}`)

  // Create worktrees for each sub-task
  const worktreePaths = new Map<string, string>()
  const branchNames = new Map<string, string>()

  for (const subTask of decomposeOutput.sub_tasks) {
    const wtPath = worktreePath(taskId, subTask.id)
    const branchName = `${featureBranch}/${subTask.id}`
    try {
      createWorktree(projectDir, wtPath, branchName)
      worktreePaths.set(subTask.id, wtPath)
      branchNames.set(subTask.id, branchName)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`  Failed to create worktree for ${subTask.id}: ${msg}`)
      cleanupWorktrees(projectDir, taskId)
      return fallbackToPipeline(opts)
    }
  }

  // Run sub-pipelines in parallel
  const maxParallel = config.decompose?.maxParallelSubTasks ?? 3
  const subResults = await runSubPipelinesParallel(
    ctx,
    decomposeOutput.sub_tasks,
    fullPlan,
    worktreePaths,
    maxParallel,
  )

  // Attach branch names to results
  const subPipelines: SubPipelineResult[] = subResults.map((r) => ({
    ...r,
    branchName: branchNames.get(r.subTaskId) ?? r.branchName,
  }))

  // Check for failures
  const failures = subPipelines.filter((r) => r.outcome === "failed")
  if (failures.length > 0) {
    logger.error(`  ${failures.length} sub-task(s) failed:`)
    for (const f of failures) {
      logger.error(`    ${f.subTaskId}: ${f.error}`)
    }
    cleanupWorktrees(projectDir, taskId)
    return fallbackToPipeline(opts)
  }

  // Post-build check: verify no file overlap across worktrees
  const filesBySubTask = new Map<string, Set<string>>()
  for (const subTask of decomposeOutput.sub_tasks) {
    const wtPath = worktreePaths.get(subTask.id)
    if (wtPath) {
      const changed = getWorktreeChangedFiles(wtPath)
      filesBySubTask.set(subTask.id, new Set(changed))
    }
  }

  const overlap = findFileOverlap(filesBySubTask)
  if (overlap.length > 0) {
    logger.warn(`  File overlap detected between sub-tasks: ${overlap.join(", ")}`)
    // Continue anyway — merge will detect conflicts if they're real
  }

  // Save state
  const decomposeState: DecomposeState = {
    taskId,
    state: "running",
    decompose: decomposeOutput,
    subPipelines,
  }
  saveDecomposeState(taskDir, decomposeState)
  logger.info("  decompose-state.json saved")

  // ─── AUTO-COMPOSE ──────────────────────────────────────────────────────────

  if (autoCompose) {
    logger.info("Phase 3: Auto-compose")
    const composeResult = await runCompose({
      projectDir,
      runners,
      taskId,
      taskDir,
      issueNumber,
      local: opts.local,
    })
    return composeResult
  }

  return {
    ...decomposeState,
    state: "completed",
  }
}

function findFileOverlap(filesBySubTask: Map<string, Set<string>>): string[] {
  const seen = new Map<string, string>()
  const overlaps: string[] = []

  for (const [subTaskId, files] of filesBySubTask) {
    for (const file of files) {
      const existing = seen.get(file)
      if (existing) {
        overlaps.push(`${file} (${existing} + ${subTaskId})`)
      } else {
        seen.set(file, subTaskId)
      }
    }
  }

  return overlaps
}

async function fallbackToPipeline(opts: DecomposeOptions): Promise<DecomposeState> {
  logger.info("  Delegating to normal pipeline (runPipeline)...")

  const { runPipeline } = await import("../pipeline.js")

  const ctx: PipelineContext = {
    taskId: opts.taskId,
    taskDir: opts.taskDir,
    projectDir: opts.projectDir,
    runners: opts.runners,
    sessions: {},
    input: {
      mode: "full",
      issueNumber: opts.issueNumber,
      local: opts.local,
    },
  }

  const state = await runPipeline(ctx)

  return {
    taskId: opts.taskId,
    state: state.state === "completed" ? "completed" : "failed",
    decompose: {
      decomposable: false,
      reason: "Fell back to normal pipeline",
      complexity_score: 0,
      recommended_subtasks: 0,
      sub_tasks: [],
    },
    subPipelines: [],
    mergeOutcome: "fallback",
  }
}
