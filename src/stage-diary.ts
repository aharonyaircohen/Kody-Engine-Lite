/**
 * Stage diary — LLM-distilled insights that cross-pollinate between runs.
 *
 * After a stage completes, we call a small model (Haiku / cheap tier) with
 * the stage's artifacts and ask it for a handful of reusable insights.
 * Those insights are written to the graph tagged with `stage:<name>` so they
 * flow back into the same stage's prompt on future runs and into tiered
 * memory retrieval by hall/room.
 *
 * There is no `.kody/memory/diary_*.jsonl` anymore — the graph is the only
 * store.
 */

import * as fs from "fs"
import * as path from "path"

import { resolveModel } from "./context.js"
import { getRunnerForStage } from "./pipeline/runner-selection.js"
import { getProjectConfig, anyStageNeedsProxy, getLitellmUrl } from "./config.js"
import { logger } from "./logger.js"
import { createEpisode } from "./memory/graph/episode.js"
import {
  writeFact,
  findSimilarRecentNode,
  readNodesByTag,
} from "./memory/graph/queries.js"
import type { HallType } from "./memory/graph/types.js"
import type { PipelineContext } from "./types.js"

// ─── Types ──────────────────────────────────────────────────────────────────

export type InsightKind = "lesson" | "gotcha" | "convention" | "decision"

export interface Insight {
  kind: InsightKind
  text: string
  scope?: string
}

/** Row returned by `readStageInsights` — flattened from the underlying graph node. */
export interface StageInsightRow {
  insight: Insight
  taskId: string
  timestamp: string
}

// ─── Distillation ───────────────────────────────────────────────────────────

const DISTILL_PROMPT_HEADER = `You are reviewing what happened in a single pipeline stage of a coding task.
Extract 0-5 reusable insights a future agent working on a similar task would want to know.

SKIP (do not output): status lines, test counts, file lists, tautologies, recaps of what the task says.
KEEP: gotchas discovered, constraints confirmed, conventions the codebase follows, decisions made with a reason.

Each insight has:
- kind: one of "lesson" | "gotcha" | "convention" | "decision"
- text: one or two sentences, <= 200 chars, transferable to another task
- scope: optional area like "auth", "src/server/payload", or a domain name

Output ONLY JSON. No markdown, no prose, no fences:
{"insights":[{"kind":"gotcha","text":"...","scope":"optional"}]}

Return {"insights":[]} if nothing transferable happened.
`

const STAGE_ARTIFACTS: Record<string, Array<[string, number]>> = {
  build: [
    ["task.md", 600],
    ["plan.md", 800],
    ["context.md", 600],
  ],
  "review-fix": [
    ["task.md", 400],
    ["plan.md", 600],
    ["review.md", 600],
    ["context.md", 400],
  ],
  verify: [
    ["task.md", 400],
    ["verify.md", 800],
  ],
  review: [
    ["task.md", 400],
    ["plan.md", 600],
    ["review.md", 800],
  ],
}

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

function collectArtifacts(stageName: string, taskDir: string): string {
  const spec = STAGE_ARTIFACTS[stageName]
  if (!spec) return ""
  const lines: string[] = []
  for (const [filename, maxChars] of spec) {
    const content = readArtifact(taskDir, filename, maxChars)
    if (content) {
      lines.push(`\n### ${filename}`)
      lines.push(content)
    }
  }
  return lines.join("\n")
}

const INSIGHT_KINDS: readonly InsightKind[] = [
  "lesson",
  "gotcha",
  "convention",
  "decision",
]

function parseInsights(raw: string): Insight[] {
  try {
    const cleaned = raw
      .replace(/^```json\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim()
    const parsed: unknown = JSON.parse(cleaned)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("insights" in parsed) ||
      !Array.isArray((parsed as { insights: unknown }).insights)
    ) {
      return []
    }
    const items = (parsed as { insights: unknown[] }).insights
    const out: Insight[] = []
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const rec = item as Record<string, unknown>
      const kind = rec.kind
      const text = rec.text
      const scope = rec.scope
      if (typeof kind !== "string" || !INSIGHT_KINDS.includes(kind as InsightKind)) continue
      if (typeof text !== "string") continue
      const trimmed = text.trim()
      if (!trimmed) continue
      out.push({
        kind: kind as InsightKind,
        text: trimmed.slice(0, 200),
        ...(typeof scope === "string" && scope.trim() ? { scope: scope.trim() } : {}),
      })
      if (out.length >= 5) break
    }
    return out
  } catch {
    return []
  }
}

/**
 * Call the cheap/Haiku model to distill insights from a completed stage.
 * Best-effort — returns [] on any failure.
 */
export async function distillStageInsights(
  stageName: string,
  ctx: PipelineContext,
): Promise<Insight[]> {
  if (ctx.input.dryRun) return []
  if (!STAGE_ARTIFACTS[stageName]) return []

  const artifacts = collectArtifacts(stageName, ctx.taskDir)
  if (!artifacts.trim()) return []

  const prompt =
    DISTILL_PROMPT_HEADER +
    `\nStage: ${stageName}\nTask: ${ctx.taskId}\n\n## Artifacts\n${artifacts}\n`

  try {
    const runner = getRunnerForStage(ctx, "taskify")
    const model = resolveModel("cheap")
    const config = getProjectConfig()
    const extraEnv: Record<string, string> = {}
    if (anyStageNeedsProxy(config)) {
      extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
    }

    const result = await runner.run(
      "stage_diary_distill",
      prompt,
      model,
      30_000,
      "",
      { cwd: ctx.projectDir, env: extraEnv },
    )

    if (result.outcome !== "completed" || !result.output) {
      logger.debug(`  stage-diary: distiller LLM call failed for stage=${stageName}`)
      return []
    }

    return parseInsights(result.output)
  } catch (err) {
    logger.debug(
      `  stage-diary: distillation error for stage=${stageName} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
}

// ─── Graph write ────────────────────────────────────────────────────────────

function insightKindToHall(kind: InsightKind): HallType {
  switch (kind) {
    case "convention":
      return "conventions"
    case "decision":
    case "lesson":
      return "facts"
    case "gotcha":
      return "thoughts"
  }
}

/**
 * Write distilled insights to the graph. One episode per call; one node per
 * insight that isn't a near-duplicate of a recent node in the same hall+room.
 */
export function appendStageInsights(
  ctx: PipelineContext,
  stageName: string,
  insights: Insight[],
  room?: string,
): void {
  if (insights.length === 0) return

  let episodeId: string | null = null

  for (const ins of insights) {
    const hall = insightKindToHall(ins.kind)
    const targetRoom = ins.scope ?? room ?? stageName

    if (findSimilarRecentNode(ctx.projectDir, hall, ins.text)) {
      logger.debug(
        `  stage-diary: skip duplicate [${hall}/${targetRoom}] "${ins.text.slice(0, 60)}..."`,
      )
      continue
    }

    if (!episodeId) {
      const episode = createEpisode(ctx.projectDir, {
        runId: ctx.taskId,
        source: "stage_diary",
        taskId: ctx.taskId,
        createdAt: new Date().toISOString(),
        rawContent: JSON.stringify({ stage: stageName, insights }).slice(0, 1000),
        extractedNodeIds: [],
        linkedFiles: [],
        metadata: { stage: stageName },
      })
      episodeId = episode.id
    }

    writeFact(ctx.projectDir, hall, targetRoom, ins.text, episodeId, [
      `stage:${stageName}`,
      `task:${ctx.taskId}`,
      `kind:${ins.kind}`,
    ])
    logger.info(`  stage-diary: saved [${ins.kind}] ${targetRoom}: ${ins.text.slice(0, 80)}`)
  }
}

// ─── Read / format for prompt injection ─────────────────────────────────────

/**
 * Read recent stage-diary insights for a given stage, newest first.
 */
export function readStageInsights(
  projectDir: string,
  stageName: string,
  limit = 5,
): StageInsightRow[] {
  const nodes = readNodesByTag(projectDir, `stage:${stageName}`, limit)
  const rows: StageInsightRow[] = []
  for (const node of nodes) {
    const kindTag = node.tags?.find((t) => t.startsWith("kind:"))
    const taskTag = node.tags?.find((t) => t.startsWith("task:"))
    const kind = (kindTag?.slice("kind:".length) as InsightKind) ?? "lesson"
    if (!INSIGHT_KINDS.includes(kind)) continue
    rows.push({
      insight: {
        kind,
        text: node.content,
        ...(node.room ? { scope: node.room } : {}),
      },
      taskId: taskTag?.slice("task:".length) ?? "",
      timestamp: node.validFrom,
    })
  }
  return rows
}

/**
 * Render insights as a compact markdown block for prompt injection.
 */
export function formatStageInsightsForPrompt(
  stageName: string,
  rows: StageInsightRow[],
): string {
  if (rows.length === 0) return ""
  const lines: string[] = [
    `## Stage diary — ${stageName} (${rows.length} recent insight${rows.length === 1 ? "" : "s"})`,
  ]
  for (const row of rows) {
    const date = row.timestamp.slice(0, 10)
    const task = row.taskId ? ` (task ${row.taskId.slice(0, 12)}, ${date})` : ` (${date})`
    const scope = row.insight.scope ? ` [${row.insight.scope}]` : ""
    lines.push(`- ${row.insight.kind}${scope}: ${row.insight.text}${task}`)
  }
  return lines.join("\n")
}

// ─── Migration ──────────────────────────────────────────────────────────────

/**
 * Delete the legacy `.kody/memory/diary_*.jsonl` files if present. Their
 * contents were regex-scraped token noise; nothing worth importing.
 * Best-effort: silent on errors.
 */
export function cleanupLegacyDiaryFiles(projectDir: string): void {
  const dir = path.join(projectDir, ".kody", "memory")
  if (!fs.existsSync(dir)) return
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith("diary_") && name.endsWith(".jsonl")) {
        try {
          fs.unlinkSync(path.join(dir, name))
          logger.debug(`  stage-diary: removed legacy ${name}`)
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}
