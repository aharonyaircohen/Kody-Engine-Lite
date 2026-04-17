import * as fs from "fs"
import * as path from "path"

import type {
  StageName,
  PipelineStatus,
  PipelineContext,
} from "./types.js"
import { STAGES } from "./definitions.js"
import { resolveModel } from "./context.js"
import { getProjectConfig, anyStageNeedsProxy, getLitellmUrl } from "./config.js"
import { getRunnerForStage } from "./pipeline/runner-selection.js"
import { readProjectMemory } from "./memory.js"
import { estimateTokens } from "./context-tiers.js"
import { logger } from "./logger.js"
import { createEpisode } from "./memory/graph/episode.js"
import { getCurrentFacts, writeFact, writeEdge } from "./memory/graph/queries.js"
import { defaultConfidenceFor } from "./memory/graph/confidence.js"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TokenStats {
  totalPromptTokens: number
  memoryTokens: number
  perStage: Record<string, number>
}

export interface RetrospectiveEntry {
  timestamp: string
  taskId: string
  outcome: "completed" | "failed"
  durationMs: number
  stageResults: Record<string, {
    state: string
    retries: number
    durationMs?: number
    error?: string
  }>
  failedStage?: StageName
  observation: string
  patternMatch: string | null
  suggestion: string
  pipelineFlaw: {
    component: string
    issue: string
    evidence: string
  } | null
  tokenStats?: TokenStats
  decomposed?: boolean
  subTaskCount?: number
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const RETROSPECTIVE_PROMPT = `You are a pipeline retrospective analyst. You observe automated software development pipeline runs and identify flaws, patterns, and improvement opportunities.

Output ONLY valid JSON. No markdown fences. No explanation.

{
  "observation": "One paragraph: what happened in this run, what went well, what went wrong",
  "patternMatch": "If this matches a pattern seen in previous runs, describe the pattern. Otherwise null",
  "suggestion": "One specific, actionable change to improve pipeline reliability or efficiency",
  "pipelineFlaw": {
    "component": "pipeline component name (e.g., verify, build, autofix, taskify prompt, review prompt, model selection, timeout config)",
    "issue": "concise description of the flaw",
    "evidence": "specific data from this run that supports this conclusion"
  },
  "contributingFactIds": ["fact_..."]
}

If no pipeline flaw is detected, set "pipelineFlaw" to null.

"contributingFactIds" is an OPTIONAL list of fact IDs from the Current Project Memory section below that were known to the pipeline and plausibly contributed to this run's outcome (success or failure). Only include ids that literally appear in that section — no inventing. If none contributed or if no memory is present, return [].

`

// ─── Context Collection ─────────────────────────────────────────────────────

function readArtifact(taskDir: string, filename: string, maxChars: number): string | null {
  const p = path.join(taskDir, filename)
  if (!fs.existsSync(p)) return null
  try {
    const content = fs.readFileSync(p, "utf-8")
    return content.length > maxChars
      ? content.slice(0, maxChars) + "\n...(truncated)"
      : content
  } catch {
    return null
  }
}

function computeStageDuration(stage: { startedAt?: string; completedAt?: string }): number | undefined {
  if (!stage.startedAt) return undefined
  const end = stage.completedAt ?? new Date().toISOString()
  return new Date(end).getTime() - new Date(stage.startedAt).getTime()
}

export function collectRunContext(
  ctx: PipelineContext,
  state: PipelineStatus,
  pipelineStartTime: number,
): string {
  const durationMs = Date.now() - pipelineStartTime
  const lines: string[] = []

  lines.push(`## This Run`)
  lines.push(`Task: ${state.taskId}`)
  lines.push(`Outcome: ${state.state}`)
  lines.push(`Duration: ${durationMs}ms (${Math.round(durationMs / 1000)}s)`)
  lines.push(`Mode: ${ctx.input.mode}`)
  lines.push(``)

  // Stage results
  lines.push(`### Stage Results`)
  let failedStage: StageName | undefined
  for (const def of STAGES) {
    const s = state.stages[def.name]
    const duration = computeStageDuration(s)
    const durationStr = duration != null ? `, ${duration}ms` : ""
    const tokenStr = s.promptTokens != null ? `, ~${s.promptTokens} prompt tokens` : ""
    const errorStr = s.error ? ` — ${s.error}` : ""
    lines.push(`${def.name}: ${s.state} (${s.retries} retries${durationStr}${tokenStr})${errorStr}`)
    if (s.state === "failed" || s.state === "timeout") {
      failedStage = def.name
    }
  }
  lines.push(``)

  // Artifacts summary (truncated)
  const artifacts: Array<[string, number]> = [
    ["task.md", 300],
    ["task.json", 500],
    ["plan.md", 500],
    ["verify.md", 800],
    ["review.md", 500],
    ["ship.md", 300],
  ]

  // Decompose info
  const decomposeStatePath = path.join(ctx.taskDir, "decompose-state.json")
  if (fs.existsSync(decomposeStatePath)) {
    try {
      const ds = JSON.parse(fs.readFileSync(decomposeStatePath, "utf-8"))
      lines.push(`### Decompose`)
      lines.push(`Decomposed: ${ds.decompose?.decomposable ?? false}`)
      lines.push(`Sub-tasks: ${ds.subPipelines?.length ?? 0}`)
      lines.push(`Merge outcome: ${ds.mergeOutcome ?? "n/a"}`)
      lines.push(``)
    } catch { /* ignore */ }
  }

  lines.push(`### Artifacts`)
  for (const [filename, maxChars] of artifacts) {
    const content = readArtifact(ctx.taskDir, filename, maxChars)
    if (content) {
      lines.push(`#### ${filename}`)
      lines.push(content)
      lines.push(``)
    }
  }

  return lines.join("\n")
}

// ─── Previous Retrospectives ────────────────────────────────────────────────

function getLogPath(projectDir: string): string {
  return path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
}

export function readPreviousRetrospectives(projectDir: string, limit = 10): RetrospectiveEntry[] {
  const logPath = getLogPath(projectDir)
  if (!fs.existsSync(logPath)) return []

  try {
    const content = fs.readFileSync(logPath, "utf-8")
    const lines = content.split("\n").filter(Boolean)
    const entries: RetrospectiveEntry[] = []

    // Take last N lines
    const start = Math.max(0, lines.length - limit)
    for (let i = start; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]))
      } catch {
        // Skip corrupt lines
      }
    }
    return entries
  } catch {
    return []
  }
}

function formatPreviousEntries(entries: RetrospectiveEntry[]): string {
  if (entries.length === 0) return "No previous runs recorded."

  return entries.map((e) => {
    const failed = e.failedStage ? ` at ${e.failedStage}` : ""
    const pattern = e.patternMatch ? `Pattern: ${e.patternMatch}` : "Pattern: none"
    const flaw = e.pipelineFlaw ? ` | Flaw: ${e.pipelineFlaw.component} — ${e.pipelineFlaw.issue}` : ""
    return `[${e.timestamp.slice(0, 10)}] ${e.taskId}: ${e.outcome}${failed} — "${e.observation.slice(0, 120)}"\n  ${pattern} | Suggestion: "${e.suggestion}"${flaw}`
  }).join("\n")
}

// ─── Append ─────────────────────────────────────────────────────────────────

export function appendRetrospectiveEntry(projectDir: string, entry: RetrospectiveEntry): void {
  const logPath = getLogPath(projectDir)
  const dir = path.dirname(logPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n")
}

// ─── Token Stats ────────────────────────────────────────────────────────

function computeTokenStats(
  state: PipelineStatus,
  projectDir: string,
): TokenStats | undefined {
  const perStage: Record<string, number> = {}
  let totalPromptTokens = 0
  let hasAny = false

  for (const def of STAGES) {
    const s = state.stages[def.name]
    if (s.promptTokens != null) {
      perStage[def.name] = s.promptTokens
      totalPromptTokens += s.promptTokens
      hasAny = true
    }
  }

  if (!hasAny) return undefined

  const memory = readProjectMemory(projectDir)
  const memoryTokens = memory ? estimateTokens(memory) : 0

  return { totalPromptTokens, memoryTokens, perStage }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runRetrospective(
  ctx: PipelineContext,
  state: PipelineStatus,
  pipelineStartTime: number,
): Promise<void> {
  if (ctx.input.dryRun) return

  try {
    const durationMs = Date.now() - pipelineStartTime
    const runContext = collectRunContext(ctx, state, pipelineStartTime)
    const previous = readPreviousRetrospectives(ctx.projectDir)
    const previousText = formatPreviousEntries(previous)

    // Surface current project memory with ids so the LLM can cite which
    // facts contributed. readProjectMemory now includes ids by default.
    const currentMemory = readProjectMemory(ctx.projectDir)
    const memoryBlock = currentMemory
      ? `## Current Project Memory\n${currentMemory}\n`
      : ``

    const prompt = RETROSPECTIVE_PROMPT
      + `## Run Context\n${runContext}\n\n`
      + `## Previous Retrospectives (last ${previous.length} runs)\n${previousText}\n\n`
      + memoryBlock

    const runner = getRunnerForStage(ctx, "taskify")
    const model = resolveModel("cheap")
    const config = getProjectConfig()
    const extraEnv: Record<string, string> = {}
    if (anyStageNeedsProxy(config)) {
      extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
    }
    const result = await runner.run("retrospective", prompt, model, 30_000, "", {
      cwd: ctx.projectDir,
      env: extraEnv,
    })

    let observation = "Retrospective analysis unavailable"
    let patternMatch: string | null = null
    let suggestion = "No suggestion"
    let pipelineFlaw: RetrospectiveEntry["pipelineFlaw"] = null
    let contributingFactIds: string[] = []

    if (result.outcome === "completed" && result.output) {
      const cleaned = result.output
        .replace(/^```json\s*\n?/m, "")
        .replace(/\n?```\s*$/m, "")
        .trim()

      try {
        const parsed = JSON.parse(cleaned)
        observation = parsed.observation ?? observation
        patternMatch = parsed.patternMatch ?? null
        suggestion = parsed.suggestion ?? suggestion
        if (parsed.pipelineFlaw && parsed.pipelineFlaw.component) {
          pipelineFlaw = {
            component: parsed.pipelineFlaw.component,
            issue: parsed.pipelineFlaw.issue ?? "Unknown",
            evidence: parsed.pipelineFlaw.evidence ?? "",
          }
        }
        if (Array.isArray(parsed.contributingFactIds)) {
          contributingFactIds = parsed.contributingFactIds.filter(
            (x: unknown): x is string => typeof x === "string" && x.startsWith("fact_"),
          )
        }
      } catch {
        logger.warn("  Retrospective: failed to parse LLM output")
      }
    }

    // Build deterministic fields
    const stageResults: RetrospectiveEntry["stageResults"] = {}
    let failedStage: StageName | undefined
    for (const def of STAGES) {
      const s = state.stages[def.name]
      stageResults[def.name] = {
        state: s.state,
        retries: s.retries,
        durationMs: computeStageDuration(s),
        error: s.error,
      }
      if (s.state === "failed" || s.state === "timeout") {
        failedStage = def.name
      }
    }

    const tokenStats = computeTokenStats(state, ctx.projectDir)

    // Read decompose info if available
    let decomposed: boolean | undefined
    let subTaskCount: number | undefined
    const dsPath = path.join(ctx.taskDir, "decompose-state.json")
    if (fs.existsSync(dsPath)) {
      try {
        const ds = JSON.parse(fs.readFileSync(dsPath, "utf-8"))
        decomposed = ds.decompose?.decomposable ?? false
        subTaskCount = ds.subPipelines?.length ?? 0
      } catch { /* ignore */ }
    }

    const entry: RetrospectiveEntry = {
      timestamp: new Date().toISOString(),
      taskId: state.taskId,
      outcome: state.state === "completed" ? "completed" : "failed",
      durationMs,
      stageResults,
      failedStage,
      observation,
      patternMatch,
      suggestion,
      pipelineFlaw,
      tokenStats,
      decomposed,
      subTaskCount,
    }

    appendRetrospectiveEntry(ctx.projectDir, entry)
    logger.info(`Retrospective: ${observation.slice(0, 120)}`)

    // Create a graph episode so this run is searchable via FTS
    try {
      const episodeContent = [
        `Task: ${state.taskId}`,
        `Outcome: ${state.state}`,
        `Observation: ${observation}`,
        state.state !== "completed" && failedStage ? `Failed at: ${failedStage}` : null,
        patternMatch ? `Pattern: ${patternMatch}` : null,
        suggestion ? `Suggestion: ${suggestion}` : null,
        pipelineFlaw ? `Flaw: ${pipelineFlaw.component} — ${pipelineFlaw.issue}` : null,
        `Stages: ${Object.entries(state.stages).map(([k, v]) => `${k}:${v.state}`).join(", ")}`,
      ].filter(Boolean).join(" | ")

      const episode = createEpisode(ctx.projectDir, {
        runId: ctx.taskId,
        source: state.state === "completed" ? "plan" : "ci_failure",
        taskId: ctx.taskId,
        createdAt: new Date().toISOString(),
        rawContent: episodeContent,
        extractedNodeIds: [],
        linkedFiles: [],
      })
      logger.info(`  Episode created: ${episode.id}`)

      // W-4: if the retrospective found a pipeline flaw AND identified
      // contributing facts, save a root-cause fact and link it via caused_by
      // edges to those contributors. Failed-run path only — successes don't
      // warrant a root-cause node.
      if (state.state !== "completed" && pipelineFlaw) {
        try {
          const patternFact = writeFact(
            ctx.projectDir,
            "thoughts",
            pipelineFlaw.component,
            `${pipelineFlaw.issue} — ${pipelineFlaw.evidence.slice(0, 200)}`,
            episode.id,
            ["source:ci_failure", `task:${ctx.taskId}`],
            defaultConfidenceFor("ci_failure"),
          )
          logger.info(`  Root-cause fact: ${patternFact.id}`)

          // Validate the ids exist in current memory before writing edges.
          const current = new Set(getCurrentFacts(ctx.projectDir).map((n) => n.id))
          let edgesWritten = 0
          for (const contributorId of contributingFactIds) {
            if (!current.has(contributorId)) continue
            if (contributorId === patternFact.id) continue
            writeEdge(ctx.projectDir, patternFact.id, "caused_by", contributorId, episode.id)
            edgesWritten++
          }
          if (edgesWritten > 0) {
            logger.info(`  caused_by edges: ${edgesWritten}`)
          }
        } catch (err) {
          logger.warn(`  Root-cause edge write failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      logger.warn(`  Episode creation failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  } catch (err) {
    logger.warn(`Retrospective failed: ${err instanceof Error ? err.message : err}`)
  }
}
