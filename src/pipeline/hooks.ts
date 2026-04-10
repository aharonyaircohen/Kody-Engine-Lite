import * as fs from "fs"
import * as path from "path"

import type {
  StageName,
  StageDefinition,
  PipelineStatus,
  PipelineContext,
} from "../types.js"
import { STAGES } from "../definitions.js"
import { setLifecycleLabel, setLabel, postComment } from "../github-api.js"
import { commitAll } from "../git-utils.js"
import { checkForQuestions } from "./questions.js"
import { filterByComplexity, isValidComplexity } from "./complexity.js"
import { writeState } from "./state.js"
import { logger } from "../logger.js"

// ─── Pre-stage ──────────────────────────────────────────────────────────────

export function applyPreStageLabel(ctx: PipelineContext, def: StageDefinition): void {
  if (!ctx.input.issueNumber || ctx.input.local) return
  if (def.name === "plan") setLifecycleLabel(ctx.input.issueNumber, "planning")
  if (def.name === "build") setLifecycleLabel(ctx.input.issueNumber, "building")
  if (def.name === "verify") setLifecycleLabel(ctx.input.issueNumber, "verifying")
  if (def.name === "review") setLifecycleLabel(ctx.input.issueNumber, "review")
  if (def.name === "review-fix") setLifecycleLabel(ctx.input.issueNumber, "fixing")
  if (def.name === "ship") setLifecycleLabel(ctx.input.issueNumber, "shipping")
}

// ─── Post-stage (success) ───────────────────────────────────────────────────

/**
 * Check for clarifying questions after taskify/plan.
 * Returns the paused PipelineStatus if pipeline should stop, null to continue.
 */
export function checkQuestionsAfterStage(
  ctx: PipelineContext,
  def: StageDefinition,
  state: PipelineStatus,
): PipelineStatus | null {
  if (def.name !== "taskify" && def.name !== "plan") return null
  if (ctx.input.dryRun) return null
  if (ctx.input.mode === "rerun") return null  // Skip question gate on resume (approve)
  if (ctx.input.autoMode) {
    logger.info(`  [auto-mode] question gate skipped`)
    return null
  }

  const paused = checkForQuestions(ctx, def.name)
  if (!paused) return null

  state.state = "failed"
  state.stages[def.name] = {
    ...state.stages[def.name],
    state: "completed",
    error: "paused: waiting for answers",
  }
  writeState(state, ctx.taskDir)
  logger.info(`  Pipeline paused — questions posted on issue`)
  return state
}

/**
 * Auto-detect complexity from task.json after taskify.
 * Returns new complexity + activeStages if detected, null otherwise.
 */
export function autoDetectComplexity(
  ctx: PipelineContext,
  def: StageDefinition,
): { complexity: "low" | "medium" | "high"; activeStages: StageDefinition[] } | null {
  if (def.name !== "taskify") return null

  // If complexity was explicitly overridden via --complexity flag, use it
  if (ctx.input.complexity) {
    const complexity = ctx.input.complexity as "low" | "medium" | "high"
    const activeStages = filterByComplexity(STAGES, complexity)
    logger.info(`  Complexity override: ${complexity} (${activeStages.map(s => s.name).join(" → ")})`)
    if (ctx.input.issueNumber && !ctx.input.local) {
      try { setLifecycleLabel(ctx.input.issueNumber, complexity) } catch { /* ignore */ }
    }
    return { complexity, activeStages }
  }

  try {
    const taskJsonPath = path.join(ctx.taskDir, "task.json")
    if (!fs.existsSync(taskJsonPath)) return null

    const raw = fs.readFileSync(taskJsonPath, "utf-8")
    const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const taskJson = JSON.parse(cleaned)

    if (!taskJson.risk_level || !isValidComplexity(taskJson.risk_level)) return null

    const complexity = taskJson.risk_level as "low" | "medium" | "high"
    const activeStages = filterByComplexity(STAGES, complexity)
    logger.info(`  Complexity auto-detected: ${complexity} (${activeStages.map(s => s.name).join(" → ")})`)

    if (ctx.input.issueNumber && !ctx.input.local) {
      try { setLifecycleLabel(ctx.input.issueNumber, complexity) } catch { /* ignore */ }
      if (taskJson.task_type) {
        try { setLabel(ctx.input.issueNumber, `kody:${taskJson.task_type}`) } catch { /* ignore */ }
      }
    }

    return { complexity, activeStages }
  } catch {
    return null
  }
}

/**
 * Risk gate: pause after plan for HIGH complexity tasks.
 * Returns PipelineStatus if paused (caller should return it), null to continue.
 */
export function checkRiskGate(
  ctx: PipelineContext,
  def: StageDefinition,
  state: PipelineStatus,
  complexity: string,
): PipelineStatus | null {
  if (def.name !== "plan") return null
  if (complexity !== "high") return null
  if (ctx.input.dryRun || ctx.input.local) return null
  if (ctx.input.mode === "rerun") return null
  if (!ctx.input.issueNumber) return null
  if (ctx.input.autoMode) {
    logger.info(`  [auto-mode] risk gate skipped`)
    return null
  }

  // Read plan for the comment
  const planPath = path.join(ctx.taskDir, "plan.md")
  const plan = fs.existsSync(planPath)
    ? fs.readFileSync(planPath, "utf-8").slice(0, 1500)
    : "(plan not available)"

  try {
    postComment(
      ctx.input.issueNumber,
      `🛑 **Risk gate: HIGH complexity — awaiting approval**\n\n`
      + `<details><summary>📋 Plan summary</summary>\n\n${plan}\n</details>\n\n`
      + `To approve: \`@kody approve\``,
    )
    setLifecycleLabel(ctx.input.issueNumber, "waiting")
  } catch { /* fire-and-forget */ }

  state.state = "failed"
  state.stages[def.name] = {
    ...state.stages[def.name],
    state: "completed",
    error: "paused: risk gate — awaiting approval",
  }
  writeState(state, ctx.taskDir)
  logger.info(`  Pipeline paused — HIGH risk gate, awaiting approval on issue`)
  return state
}

export function commitAfterStage(ctx: PipelineContext, def: StageDefinition): void {
  if (ctx.input.dryRun || !ctx.input.issueNumber) return

  if (def.name === "build") {
    try { commitAll(`feat(${ctx.taskId}): implement task`, ctx.projectDir) } catch { /* ignore */ }
  }
  if (def.name === "review-fix") {
    try { commitAll(`fix(${ctx.taskId}): address review`, ctx.projectDir) } catch { /* ignore */ }
  }
}

// ─── Skip logic ─────────────────────────────────────────────────────────────

export function postSkippedStagesComment(
  ctx: PipelineContext,
  complexity: string,
  activeStages: StageDefinition[],
): void {
  if (!ctx.input.issueNumber || ctx.input.local || ctx.input.dryRun) return

  const skipped = STAGES
    .filter(s => !activeStages.find(a => a.name === s.name))
    .map(s => s.name)

  if (skipped.length === 0) return

  try {
    postComment(
      ctx.input.issueNumber,
      `⚡ **Complexity: ${complexity}** — skipping ${skipped.join(", ")} (not needed for ${complexity}-risk tasks)`,
    )
  } catch { /* ignore */ }
}
