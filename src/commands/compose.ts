import * as fs from "fs"
import * as path from "path"

import type {
  PipelineContext,
  AgentRunner,
  DecomposeState,
} from "../types.js"
import { STAGES } from "../definitions.js"
import { executeVerifyWithAutofix } from "../stages/verify.js"
import { executeReviewWithFix } from "../stages/review.js"
import { executeShipStage } from "../stages/ship.js"
import { getCurrentBranch } from "../git-utils.js"
import { mergeSubTaskBranch, cleanupWorktrees } from "../worktree.js"
import { runRetrospective } from "../retrospective.js"
import { logger } from "../logger.js"

export interface ComposeOptions {
  projectDir: string
  runners: Record<string, AgentRunner>
  taskId: string
  taskDir: string
  issueNumber?: number
  local?: boolean
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

export async function runCompose(opts: ComposeOptions): Promise<DecomposeState> {
  const { projectDir, runners, taskId, taskDir, issueNumber } = opts
  const startTime = Date.now()

  // Load decompose state
  const decomposeState = loadDecomposeState(taskDir)
  if (!decomposeState) {
    logger.error("  No decompose-state.json found — run 'kody decompose' first")
    return {
      taskId,
      state: "failed",
      decompose: { decomposable: false, reason: "No state file", complexity_score: 0, recommended_subtasks: 0, sub_tasks: [] },
      subPipelines: [],
    }
  }

  // Validate all sub-pipelines completed
  const incomplete = decomposeState.subPipelines.filter((r) => r.outcome !== "completed")
  if (incomplete.length > 0) {
    logger.error(`  ${incomplete.length} sub-task(s) did not complete — cannot compose`)
    return { ...decomposeState, state: "failed" }
  }

  // Build context for verify/review/ship stages
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

  // ─── MERGE PHASE ──────────────────────────────────────────────────────────

  // Skip merge if already merged (re-run scenario)
  if (decomposeState.mergeOutcome !== "merged") {
    logger.info("Compose Phase 1: Merge")
    const currentBranch = getCurrentBranch(projectDir)
    logger.info(`  Merging into: ${currentBranch}`)

    for (const subResult of decomposeState.subPipelines) {
      if (!subResult.branchName) continue

      logger.info(`  Merging ${subResult.branchName}...`)
      const mergeResult = mergeSubTaskBranch(subResult.branchName, projectDir)

      if (mergeResult === "conflict") {
        logger.error(`  Merge conflict on branch: ${subResult.branchName}`)
        const failedState: DecomposeState = {
          ...decomposeState,
          state: "failed",
          mergeOutcome: "conflict",
        }
        saveDecomposeState(taskDir, failedState)
        return failedState
      }
    }

    // Merge succeeded — update state
    decomposeState.mergeOutcome = "merged"
    saveDecomposeState(taskDir, decomposeState)
    logger.info("  All branches merged successfully")

    // Cleanup worktrees after successful merge
    cleanupWorktrees(projectDir, taskId)
  } else {
    logger.info("Compose Phase 1: Merge (skipped — already merged)")
  }

  // ─── VERIFY + REVIEW PHASE ────────────────────────────────────────────────

  logger.info("Compose Phase 2: Verify + Review")

  const verifyDef = STAGES.find((s) => s.name === "verify")!
  const verifyResult = await executeVerifyWithAutofix(ctx, verifyDef)
  const verifyOutcome = verifyResult.outcome === "completed" ? "completed" as const : "failed" as const

  if (verifyResult.outcome !== "completed") {
    logger.error(`  Verify failed: ${verifyResult.error}`)
    const failedState: DecomposeState = {
      ...decomposeState,
      state: "failed",
      compose: { verify: "failed", review: "failed", ship: "failed" },
    }
    saveDecomposeState(taskDir, failedState)
    return failedState
  }

  const reviewDef = STAGES.find((s) => s.name === "review")!
  const reviewResult = await executeReviewWithFix(ctx, reviewDef)
  const reviewOutcome = reviewResult.outcome === "completed" ? "completed" as const : "failed" as const

  // Review failure is non-fatal — we still ship (review verdict is in PR body)

  // ─── SHIP PHASE ────────────────────────────────────────────────────────────

  logger.info("Compose Phase 3: Ship")
  const shipDef = STAGES.find((s) => s.name === "ship")!
  const shipResult = executeShipStage(ctx, shipDef)
  const shipOutcome = shipResult.outcome === "completed" ? "completed" as const : "failed" as const

  // Update final state
  const finalState: DecomposeState = {
    ...decomposeState,
    state: shipOutcome === "completed" ? "completed" : "failed",
    compose: {
      verify: verifyOutcome,
      review: reviewOutcome,
      ship: shipOutcome,
    },
  }
  saveDecomposeState(taskDir, finalState)

  // Run retrospective (async, non-blocking)
  try {
    // Build a minimal PipelineStatus for retrospective
    const { initState } = await import("../pipeline/state.js")
    const pipelineStatus = initState(taskId)
    pipelineStatus.state = finalState.state === "completed" ? "completed" : "failed"
    await runRetrospective(ctx, pipelineStatus, startTime)
  } catch (err) {
    logger.warn(`  Retrospective failed: ${err instanceof Error ? err.message : err}`)
  }

  if (finalState.state === "completed") {
    logger.info("Compose completed successfully")
  } else {
    logger.error("Compose failed")
  }

  return finalState
}
