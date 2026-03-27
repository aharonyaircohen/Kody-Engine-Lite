import * as fs from "fs"
import * as path from "path"

import type {
  StageName,
  StageState,
  PipelineStatus,
} from "../types.js"
import { STAGES } from "../definitions.js"

export function loadState(taskId: string, taskDir: string): PipelineStatus | null {
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

export function writeState(state: PipelineStatus, taskDir: string): void {
  const updated: PipelineStatus = {
    ...state,
    updatedAt: new Date().toISOString(),
  }
  const target = path.join(taskDir, "status.json")
  const tmp = target + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2))
  fs.renameSync(tmp, target)
  // Sync the caller's reference
  state.updatedAt = updated.updatedAt
}

export function initState(taskId: string): PipelineStatus {
  const stages = {} as Record<StageName, StageState>
  for (const stage of STAGES) {
    stages[stage.name] = { state: "pending", retries: 0 }
  }
  const now = new Date().toISOString()
  return { taskId, state: "running", stages, createdAt: now, updatedAt: now }
}
