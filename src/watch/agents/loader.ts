/**
 * Discovers and loads watch agent definitions from .kody/watch/agents/<name>/ folders.
 * Each agent folder must contain agent.json (config) and agent.md (system prompt).
 */

import * as fs from "fs"
import * as path from "path"
import type { WatchAgentConfig, WatchAgentDefinition } from "../core/types.js"

const AGENTS_DIR = ".kody/watch/agents"

interface LoadResult {
  agents: WatchAgentDefinition[]
  warnings: string[]
}

function validateAgentConfig(raw: unknown, dirName: string): WatchAgentConfig | string {
  if (!raw || typeof raw !== "object") {
    return `${dirName}: agent.json must be a JSON object`
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.name !== "string" || !obj.name.trim()) {
    return `${dirName}: agent.json missing required "name" (string)`
  }
  if (typeof obj.description !== "string" || !obj.description.trim()) {
    return `${dirName}: agent.json missing required "description" (string)`
  }
  if (typeof obj.cron !== "string" || !obj.cron.trim()) {
    return `${dirName}: agent.json missing required "cron" (string, e.g. "0 9 * * *")`
  }

  return {
    name: obj.name.trim(),
    description: obj.description.trim(),
    cron: obj.cron.trim(),
    reportOnFailure: obj.reportOnFailure === true,
    timeoutMs:
      typeof obj.timeoutMs === "number" && obj.timeoutMs > 0 ? obj.timeoutMs : undefined,
  }
}

export function loadWatchAgents(projectDir: string): LoadResult {
  const agentsDir = path.join(projectDir, AGENTS_DIR)
  const warnings: string[] = []
  const agents: WatchAgentDefinition[] = []

  if (!fs.existsSync(agentsDir)) {
    return { agents, warnings }
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  } catch {
    warnings.push(`Cannot read ${AGENTS_DIR}`)
    return { agents, warnings }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const dirPath = path.join(agentsDir, entry.name)
    const jsonPath = path.join(dirPath, "agent.json")
    const mdPath = path.join(dirPath, "agent.md")

    // Both files required
    if (!fs.existsSync(jsonPath)) {
      warnings.push(`${entry.name}: missing agent.json — skipped`)
      continue
    }
    if (!fs.existsSync(mdPath)) {
      warnings.push(`${entry.name}: missing agent.md — skipped`)
      continue
    }

    // Parse and validate agent.json
    let rawJson: unknown
    try {
      rawJson = JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
    } catch {
      warnings.push(`${entry.name}: agent.json is invalid JSON — skipped`)
      continue
    }

    const configOrError = validateAgentConfig(rawJson, entry.name)
    if (typeof configOrError === "string") {
      warnings.push(`${configOrError} — skipped`)
      continue
    }

    // Read system prompt
    const systemPrompt = fs.readFileSync(mdPath, "utf-8").trim()
    if (!systemPrompt) {
      warnings.push(`${entry.name}: agent.md is empty — skipped`)
      continue
    }

    agents.push({
      config: configOrError,
      systemPrompt,
      dirPath,
    })
  }

  return { agents, warnings }
}
