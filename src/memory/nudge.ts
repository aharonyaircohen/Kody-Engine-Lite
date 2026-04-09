/**
 * Memory nudge engine.
 *
 * After a successful task, the LLM reviews the artifacts and asks:
 * "Should I save any pattern from this task?" — if yes, writes to graph memory.
 *
 * Inspired by hermes-agent's closed learning loop.
 * Gate: KODY_MEMORY_NUDGE=true env var (opt-in).
 */

import * as fs from "fs"
import * as path from "path"

import { logger } from "../logger.js"
import { resolveModel } from "../context.js"
import { getRunnerForStage } from "../pipeline/runner-selection.js"
import { getProjectConfig, anyStageNeedsProxy, getLitellmUrl } from "../config.js"
import type { PipelineContext } from "../types.js"
import { writeFact } from "./graph/queries.js"
import { createEpisode } from "./graph/episode.js"
import type { HallType } from "./graph/types.js"

const NUDGE_ENV_FLAG = "KODY_MEMORY_NUDGE"

interface NudgePattern {
  hall: HallType
  room: string
  content: string
}

const NUDGE_PROMPT = `You are a software development memory analyst. Review this completed task and identify any reusable patterns worth saving to long-term memory.

Halls you can write to:
- facts: factual knowledge about the project ("uses PostgreSQL", "test coverage is ~70%")
- conventions: coding conventions and patterns ("imports use .js extensions", "use Zod for validation")
- preferences: user preferences learned from feedback ("user prefers terse responses")
- thoughts: notable insights about this task ("JWT validation was tricky here")
- events: things that happened ("CI failed due to missing env var")

Output ONLY valid JSON. No markdown fences. No explanation.

{
  "patterns": [
    {
      "hall": "conventions | facts | preferences | thoughts | events",
      "room": "short descriptive name for this pattern (e.g. 'auth', 'testing', 'user-style')",
      "content": "one or two sentences describing the pattern"
    }
  ]
}

Only include patterns that are genuinely useful and not already obvious from the code.
If no useful patterns are found, return {"patterns": []}.
`

function readArtifact(taskDir: string, filename: string, maxChars = 1000): string | null {
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

function collectNudgeContext(ctx: PipelineContext): string {
  const lines: string[] = []
  lines.push(`Task: ${ctx.taskId}`)

  const artifacts: Array<[string, number]> = [
    ["task.md", 300],
    ["task.json", 400],
    ["plan.md", 600],
    ["review.md", 600],
    ["verify.md", 400],
    ["ship.md", 200],
  ]

  for (const [filename, maxChars] of artifacts) {
    const content = readArtifact(ctx.taskDir, filename, maxChars)
    if (content) {
      lines.push(`\n### ${filename}`)
      lines.push(content)
    }
  }

  return lines.join("\n")
}

function parsePatterns(raw: string): NudgePattern[] {
  try {
    const cleaned = raw
      .replace(/^```json\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed.patterns)) return []
    return parsed.patterns.filter(
      (p: unknown): p is NudgePattern =>
        typeof p === "object" &&
        p !== null &&
        "hall" in p && typeof p.hall === "string" &&
        "room" in p && typeof p.room === "string" &&
        "content" in p && typeof p.content === "string",
    )
  } catch {
    return []
  }
}

/**
 * Main nudge function. Runs after a successful ship stage.
 * Opt-in via KODY_MEMORY_NUDGE=true env var.
 */
export async function nudge(ctx: PipelineContext): Promise<void> {
  if (!process.env[NUDGE_ENV_FLAG]) return
  if (ctx.input.dryRun) return

  try {
    const context = collectNudgeContext(ctx)
    const prompt = NUDGE_PROMPT + `\n## Task Artifacts\n${context}\n`

    const runner = getRunnerForStage(ctx, "taskify")
    const model = resolveModel("cheap")
    const config = getProjectConfig()
    const extraEnv: Record<string, string> = {}
    if (anyStageNeedsProxy(config)) {
      extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
    }

    const result = await runner.run("nudge", prompt, model, 30_000, "", {
      cwd: ctx.projectDir,
      env: extraEnv,
    })

    if (result.outcome !== "completed" || !result.output) {
      logger.warn("  Nudge: LLM call failed or returned no output")
      return
    }

    const patterns = parsePatterns(result.output)
    if (patterns.length === 0) {
      logger.info("  Nudge: no patterns to save")
      return
    }

    // Create a single episode for all patterns from this nudge
    const episode = createEpisode(ctx.projectDir, {
      runId: ctx.taskId,
      source: "nudge",
      taskId: ctx.taskId,
      createdAt: new Date().toISOString(),
      rawContent: `LLM nudge identified ${patterns.length} pattern(s)`,
      extractedNodeIds: [],
      linkedFiles: [],
    })

    // Write nodes and collect their IDs
    const nodeIds: string[] = []
    for (const pattern of patterns) {
      const node = writeFact(
        ctx.projectDir,
        pattern.hall,
        pattern.room,
        pattern.content,
        episode.id,
      )
      nodeIds.push(node.id)
      logger.info(`  Nudge: saved pattern [${pattern.hall}] ${pattern.room}: ${node.id}`)
    }

    // Backfill extractedNodeIds on the episode now that we have node IDs
    const episodePath = path.join(ctx.projectDir, ".kody", "graph", "episodes", `${episode.id}.json`)
    const episodeData = JSON.parse(fs.readFileSync(episodePath, "utf-8"))
    episodeData.extractedNodeIds = nodeIds
    fs.writeFileSync(episodePath, JSON.stringify(episodeData, null, 2) + "\n")

    logger.info(`  Nudge: saved ${patterns.length} pattern(s) from ${ctx.taskId}`)
  } catch (err) {
    logger.warn(`  Nudge: failed — ${err instanceof Error ? err.message : String(err)}`)
  }
}
