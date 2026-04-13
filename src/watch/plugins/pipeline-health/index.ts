/**
 * Pipeline Health plugin — monitors .kody/tasks/ for stalled, failed, or stuck tasks.
 * Writes failure events to the graph for cross-run context.
 * Runs every cycle (every 30 min).
 */

import * as fs from "fs"
import * as path from "path"

import type { WatchPlugin, ActionRequest, WatchContext } from "../../core/types.js"
import { createEpisode, factExists, writeFactOnce } from "../../../memory/graph/index.js"

interface TaskStatus {
  taskId: string
  state: string
  stages: Record<string, { state: string; startedAt?: string; completedAt?: string; error?: string }>
  startedAt?: string
  completedAt?: string
}

interface TaskHealth {
  taskId: string
  status: string
  health: "healthy" | "stalled" | "failed" | "stuck-retry"
  detail: string
  durationMinutes?: number
  failedStage?: string
}

const STALL_THRESHOLD_MINUTES = 30

function discoverTasks(cwd: string): TaskStatus[] {
  const tasksDir = path.join(cwd, ".kody", "tasks")
  if (!fs.existsSync(tasksDir)) return []

  const tasks: TaskStatus[] = []

  try {
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const statusPath = path.join(tasksDir, entry.name, "status.json")
      if (!fs.existsSync(statusPath)) continue

      try {
        const content = fs.readFileSync(statusPath, "utf-8")
        const status = JSON.parse(content)
        tasks.push({ taskId: entry.name, ...status })
      } catch {
        // Malformed status file
      }
    }
  } catch {
    // Can't read tasks directory
  }

  return tasks
}

function evaluateHealth(task: TaskStatus): TaskHealth {
  const now = Date.now()

  // Failed task
  if (task.state === "failed") {
    const failedStage = Object.entries(task.stages || {}).find(([, s]) => s.state === "failed")
    return {
      taskId: task.taskId,
      status: task.state,
      health: "failed",
      detail: failedStage
        ? `Failed at stage '${failedStage[0]}': ${failedStage[1].error || "unknown error"}`
        : "Pipeline failed",
      failedStage: failedStage?.[0],
    }
  }

  // Running task — check for stall
  if (task.state === "running" || task.state === "in-progress") {
    const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : 0
    if (startedAt > 0) {
      const durationMinutes = Math.round((now - startedAt) / 60_000)
      if (durationMinutes > STALL_THRESHOLD_MINUTES) {
        // Find which stage is currently running
        const runningStage = Object.entries(task.stages || {}).find(
          ([, s]) => s.state === "running" || s.state === "in-progress",
        )
        return {
          taskId: task.taskId,
          status: task.state,
          health: "stalled",
          detail: runningStage
            ? `Stalled at stage '${runningStage[0]}' for ${durationMinutes} min`
            : `Running for ${durationMinutes} min without progress`,
          durationMinutes,
        }
      }
    }

    return {
      taskId: task.taskId,
      status: task.state,
      health: "healthy",
      detail: "Running normally",
    }
  }

  // Completed or other state
  return {
    taskId: task.taskId,
    status: task.state,
    health: "healthy",
    detail: task.state === "completed" ? "Completed successfully" : `Status: ${task.state}`,
  }
}

// ─── Graph Memory Wiring ────────────────────────────────────────────────────────

function writeHealthEvents(ctx: WatchContext, unhealthy: TaskHealth[]): void {
  try {
    const episode = createEpisode(ctx.projectDir, {
      runId: `watch-cycle-${ctx.cycleNumber}`,
      source: "ci_failure",
      taskId: `cycle-${ctx.cycleNumber}`,
      createdAt: new Date().toISOString(),
      rawContent: `Pipeline health: ${unhealthy.length} unhealthy task(s)`,
      extractedNodeIds: [],
    })

    const written: string[] = []
    for (const h of unhealthy) {
      const content = `Pipeline task '${h.taskId}' is ${h.health}: ${h.detail}`
      if (!factExists(ctx.projectDir, "events", "ci", content)) {
        const node = writeFactOnce(ctx.projectDir, "events", "ci", content, episode.id)
        if (node) written.push(node.id)
      }
    }

    if (written.length > 0) {
      ctx.log.info(
        { count: written.length, episodeId: episode.id },
        "Wrote pipeline health events to graph",
      )
    }
  } catch (err) {
    ctx.log.warn(`  Graph write failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── Digest Formatting ─────────────────────────────────────────────────────────

function formatDigestMarkdown(evaluations: TaskHealth[], cycleNumber: number): string {
  const unhealthy = evaluations.filter((e) => e.health !== "healthy")
  if (unhealthy.length === 0) return ""

  let md = `## Pipeline Health — Cycle #${cycleNumber}\n\n`
  md += `| Task | Status | Health | Detail |\n`
  md += `|------|--------|--------|--------|\n`

  for (const e of unhealthy) {
    const icon = e.health === "failed" ? "🔴" : e.health === "stalled" ? "🟡" : "🟠"
    md += `| \`${e.taskId}\` | ${e.status} | ${icon} ${e.health} | ${e.detail} |\n`
  }

  md += `\n_Generated by Kody Watch on ${new Date().toISOString()}_`
  return md
}

export const pipelineHealthPlugin: WatchPlugin = {
  name: "pipeline-health",
  description: "Monitor .kody/tasks/ for stalled, failed, or stuck pipeline runs",
  domain: "pipeline",
  schedule: { cron: "* * * * *" },

  async run(ctx): Promise<ActionRequest[]> {
    const tasks = discoverTasks(process.cwd())

    if (tasks.length === 0) {
      ctx.log.info("No tasks found — skipping pipeline-health")
      return []
    }

    const evaluations = tasks.map(evaluateHealth)
    const unhealthy = evaluations.filter((e) => e.health !== "healthy")

    ctx.log.info(
      { total: tasks.length, unhealthy: unhealthy.length },
      "Pipeline health scan complete",
    )

    if (unhealthy.length === 0) return []

    // Write events to the graph (non-blocking)
    writeHealthEvents(ctx, unhealthy)

    const actions: ActionRequest[] = []

    // Post digest
    if (ctx.activityLog) {
      actions.push({
        plugin: "pipeline-health",
        type: "digest",
        urgency: "warning",
        title: "Pipeline Health Report",
        detail: `${unhealthy.length} unhealthy task(s)`,
        dedupKey: "pipeline-health:digest",
        dedupWindowMinutes: 25, // Slightly less than 30 min cycle
        async execute(execCtx: WatchContext) {
          if (!execCtx.activityLog) return { success: false, message: "No activity log" }
          const markdown = formatDigestMarkdown(evaluations, execCtx.cycleNumber)
          if (!markdown) return { success: true, message: "No unhealthy tasks" }
          execCtx.github.postComment(execCtx.activityLog, markdown)
          return { success: true, message: `Reported ${unhealthy.length} unhealthy task(s)` }
        },
      })
    }

    return actions
  },
}
