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
        lines.push(`- ${content} (added ${date})`)
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
