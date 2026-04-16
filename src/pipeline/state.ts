import * as fs from "fs"
import * as path from "path"

import type {
  StageName,
  StageState,
  PipelineStatus,
} from "../types.js"
import { STAGES } from "../definitions.js"
import { parseJsonSafe } from "../validators.js"
import { logger } from "../logger.js"

export function loadState(taskId: string, taskDir: string): PipelineStatus | null {
  const p = path.join(taskDir, "status.json")
  if (!fs.existsSync(p)) return null
  try {
    const result = parseJsonSafe<PipelineStatus>(
      fs.readFileSync(p, "utf-8"),
      ["taskId", "state", "stages", "createdAt", "updatedAt"],
    )
    if (!result.ok) {
      logger.warn(`  Corrupt status.json: ${result.error}`)
      return loadStateFromBackup(taskId, taskDir)
    }
    if (result.data.taskId !== taskId) return null
    return result.data
  } catch {
    // Unexpected error (e.g., file deleted between existsSync and read) — try backup
    return loadStateFromBackup(taskId, taskDir)
  }
}

function loadStateFromBackup(taskId: string, taskDir: string): PipelineStatus | null {
  const bak = path.join(taskDir, "status.json.bak")
  if (!fs.existsSync(bak)) return null
  try {
    logger.warn(`  Restoring status.json from backup`)
    const result = parseJsonSafe<PipelineStatus>(
      fs.readFileSync(bak, "utf-8"),
      ["taskId", "state", "stages", "createdAt", "updatedAt"],
    )
    if (!result.ok) return null
    if (result.data.taskId !== taskId) return null
    return result.data
  } catch {
    return null
  }
}

export function writeState(state: PipelineStatus, taskDir: string): PipelineStatus {
  const updated: PipelineStatus = {
    ...state,
    updatedAt: new Date().toISOString(),
  }
  const target = path.join(taskDir, "status.json")
  const tmp = target + ".tmp"
  const bak = target + ".bak"

  // Backup existing status.json before overwriting (crash recovery)
  if (fs.existsSync(target)) {
    try { fs.copyFileSync(target, bak) } catch { /* best effort */ }
  }

  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2))
  fs.renameSync(tmp, target)
  return updated
}

export function initState(taskId: string): PipelineStatus {
  const stages = {} as Record<StageName, StageState>
  for (const stage of STAGES) {
    stages[stage.name] = { state: "pending", retries: 0 }
  }
  const now = new Date().toISOString()
  return { taskId, state: "running", stages, createdAt: now, updatedAt: now }
}
