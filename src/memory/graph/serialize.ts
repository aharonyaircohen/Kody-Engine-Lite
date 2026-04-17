/**
 * Serialize graph nodes to markdown for prompt injection.
 *
 * Output format mirrors the legacy .md file format:
 *
 *   ## facts
 *   ### auth
 *   - Use session cookies (added 2026-03-15)
 *
 *   ## conventions
 *   ### testing
 *   - Use Vitest (added 2026-03-15)
 */

import { type GraphNode, HallTypeValues, type HallType } from "./types.js"

interface SerializeOptions {
  includeHall?: boolean
  maxLength?: number
  /** Include node ids inline so the LLM can cite them in its output. */
  includeIds?: boolean
  /** Include confidence inline (e.g. c=0.9) when the node has it. */
  includeConfidence?: boolean
}

/**
 * Convert a list of graph nodes to markdown for prompt injection.
 */
export function graphNodesToMarkdown(
  nodes: GraphNode[],
  options?: SerializeOptions,
): string {
  if (nodes.length === 0) return ""

  // Group by hall, then by room
  const byHall = new Map<HallType, Map<string, GraphNode[]>>()

  for (const node of nodes) {
    if (!byHall.has(node.hall)) {
      byHall.set(node.hall, new Map())
    }
    const rooms = byHall.get(node.hall)!
    if (!rooms.has(node.room)) {
      rooms.set(node.room, [])
    }
    rooms.get(node.room)!.push(node)
  }

  const lines: string[] = []

  for (const hall of HallTypeValues) {
    const rooms = byHall.get(hall)
    if (!rooms || rooms.size === 0) continue

    lines.push(`## ${hall}`)

    for (const [room, roomNodes] of rooms) {
      lines.push(`### ${room}`)
      for (const node of roomNodes) {
        const date = formatDate(node.validFrom)
        const content = options?.maxLength
          ? truncate(node.content, options.maxLength)
          : node.content
        const meta: string[] = [`added ${date}`]
        if (options?.includeConfidence && typeof node.confidence === "number") {
          meta.push(`c=${node.confidence.toFixed(2).replace(/\.?0+$/, "")}`)
        }
        if (options?.includeIds) {
          meta.push(`id=${node.id}`)
        }
        lines.push(`- ${content} (${meta.join(", ")})`)
      }
      lines.push("")
    }
  }

  const result = lines.join("\n").trimEnd()
  return result ? `${result}\n` : ""
}

function formatDate(isoString: string): string {
  try {
    return isoString.slice(0, 10) // "2026-04-01"
  } catch {
    return isoString
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "..."
}

// ─── Recent changes (Phase W-5) ──────────────────────────────────────────────

import type { RecentChange } from "./queries.js"

/**
 * Render a list of RecentChange rows as a markdown block suitable for
 * prepending to a plan-stage prompt. Returns empty string when the list
 * is empty.
 */
export function recentChangesToMarkdown(changes: RecentChange[], maxRows = 20): string {
  if (changes.length === 0) return ""

  const rows = changes.slice(0, maxRows)
  const lines: string[] = [`## Recent memory changes`, ``]
  for (const c of rows) {
    const date = formatDate(c.changedAt)
    if (c.kind === "retracted") {
      lines.push(
        `- **${c.previous.hall}/${c.previous.room}** (retracted ${date}): "${truncate(c.previous.content, 120)}"`,
      )
    } else if (c.current) {
      lines.push(
        `- **${c.previous.hall}/${c.previous.room}** (updated ${date}):`,
      )
      lines.push(`  was: "${truncate(c.previous.content, 120)}"`)
      lines.push(`  now: "${truncate(c.current.content, 120)}"`)
    }
  }
  return lines.join("\n")
}
