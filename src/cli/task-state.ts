import * as fs from "fs"
import * as path from "path"

import { findLatestTaskForIssue, generateTaskId } from "./task-resolution.js"
import { getIssueLabels } from "../github-api.js"

const STAGE_ORDER = ["taskify", "plan", "build", "verify", "review", "review-fix", "ship"]

interface TaskState {
  taskId: string
  state: "running" | "completed" | "failed"
  stages: Record<string, { state: string; error?: string }>
}

export type TaskAction =
  | { action: "start-fresh"; taskId: string }
  | { action: "resume"; taskId: string; fromStage: string }
  | { action: "already-completed"; taskId: string }
  | { action: "already-running"; taskId: string }

export function resolveTaskAction(
  issueNumber: number,
  existingTaskId: string | null,
  existingState: TaskState | null,
): TaskAction {
  if (!existingTaskId || !existingState) {
    return { action: "start-fresh", taskId: `${issueNumber}-${generateTaskId()}` }
  }

  if (existingState.state === "completed") {
    return { action: "already-completed", taskId: existingTaskId }
  }

  if (existingState.state === "running") {
    return { action: "already-running", taskId: existingTaskId }
  }

  if (existingState.state === "failed") {
    for (const stageName of STAGE_ORDER) {
      const stage = existingState.stages[stageName]
      if (!stage) continue

      if (stage.error?.includes("paused")) {
        const idx = STAGE_ORDER.indexOf(stageName)
        if (idx < STAGE_ORDER.length - 1) {
          return { action: "resume", taskId: existingTaskId, fromStage: STAGE_ORDER[idx + 1] }
        }
      }

      if (stage.state === "failed" || stage.state === "pending") {
        return { action: "resume", taskId: existingTaskId, fromStage: stageName }
      }
    }

    return { action: "resume", taskId: existingTaskId, fromStage: "taskify" }
  }

  return { action: "start-fresh", taskId: `${issueNumber}-${generateTaskId()}` }
}

export function resolveForIssue(
  issueNumber: number,
  projectDir: string,
): TaskAction {
  // First: check local task state (works locally and when .tasks/ persists)
  const existingTaskId = findLatestTaskForIssue(issueNumber, projectDir)
  if (existingTaskId) {
    const statusPath = path.join(projectDir, ".tasks", existingTaskId, "status.json")
    let existingState: TaskState | null = null
    if (fs.existsSync(statusPath)) {
      try {
        existingState = JSON.parse(fs.readFileSync(statusPath, "utf-8"))
      } catch { /* ignore */ }
    }
    return resolveTaskAction(issueNumber, existingTaskId, existingState)
  }

  // Second: check GitHub labels (works in CI where .tasks/ doesn't persist)
  try {
    const labels = getIssueLabels(issueNumber)
    if (labels.includes("kody:done")) {
      return { action: "already-completed", taskId: `${issueNumber}-unknown` }
    }
  } catch { /* ignore — gh may not be available */ }

  return resolveTaskAction(issueNumber, null, null)
}
