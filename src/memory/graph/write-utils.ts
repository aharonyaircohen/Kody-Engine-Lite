/**
 * Write helpers for the graph store.
 *
 * - factExists   — check if a currently-valid fact with identical hall+room+content exists
 * - inferRoom    — extract a room slug from a list of file paths
 * - writeFactOnce — write only if not already present (dedup), TOCTOU-safe under lock
 */

import { readNodes, writeNodes } from "./store.js"
import { withGraphLockSync } from "./lock.js"
import { nodeIdWithTimestamp, type HallType, type GraphNode } from "./types.js"

/**
 * Returns true if a currently-valid fact with identical hall + room + content exists.
 *
 * NB: Not lock-guarded — intended for read-only checks outside a transaction.
 * The equivalent check inside writeFactOnce runs under the graph lock.
 */
export function factExists(
  projectDir: string,
  hall: HallType,
  room: string,
  content: string,
): boolean {
  const nodes = readNodes(projectDir)
  const normalized = content.toLowerCase().trim()
  for (const n of Object.values(nodes)) {
    if (n.validTo !== null) continue
    if (n.hall !== hall) continue
    if (n.room !== room) continue
    if (n.content.toLowerCase().trim() === normalized) return true
  }
  return false
}

/**
 * Extract a room slug from a list of file paths.
 *
 * Picks the most specific (deepest) path segment that looks like an identifier
 * rather than a common prefix. Falls back to "general".
 *
 * Examples:
 *   ["src/auth/login.ts", "src/auth/session.ts"] → "auth"
 *   ["src/components/Button.vue", "src/components/Input.vue"] → "components"
 *   ["server.py", "client.ts"] → "general"
 */
export function inferRoom(scope: string[]): string {
  if (scope.length === 0) return "general"

  // Collect all unique path segments
  const segmentCounts: Record<string, number> = {}
  for (const filePath of scope) {
    const parts = filePath.split("/")
    for (const part of parts) {
      // Skip common non-informative segments
      if (
        part === "" ||
        part === "src" ||
        part === "lib" ||
        part === "app" ||
        part === "packages" ||
        part === "internal" ||
        part === "dist" ||
        part === ".kody"
      ) {
        continue
      }
      // Skip file extensions and numeric/dot prefixes (v1, 02-, etc.)
      if (part.includes(".") || /^\d/.test(part)) continue
      segmentCounts[part] = (segmentCounts[part] ?? 0) + 1
    }
  }

  if (Object.keys(segmentCounts).length === 0) return "general"

  // Pick the most common segment
  const dominant = Object.entries(segmentCounts).sort((a, b) => b[1] - a[1])
  return dominant[0][0]
}

/**
 * Write a fact only if an identical one does not already exist.
 * Returns the written node, or null if skipped (duplicate).
 *
 * The existence check AND the write happen inside one graph-lock critical
 * section — this eliminates the TOCTOU race that a naïve factExists + writeFact
 * pair would have.
 */
export function writeFactOnce(
  projectDir: string,
  hall: HallType,
  room: string,
  content: string,
  episodeId: string,
  tags?: string[],
): GraphNode | null {
  return withGraphLockSync(projectDir, () => {
    const nodes = readNodes(projectDir)
    const normalized = content.toLowerCase().trim()

    for (const n of Object.values(nodes)) {
      if (n.validTo !== null) continue
      if (n.hall !== hall) continue
      if (n.room !== room) continue
      if (n.content.toLowerCase().trim() === normalized) return null
    }

    const id = nodeIdWithTimestamp(hall, room)
    const now = new Date().toISOString()
    const node: GraphNode = {
      id,
      type: hall,
      hall,
      room,
      content,
      episodeId,
      validFrom: now,
      validTo: null,
      ...(tags && tags.length > 0 ? { tags } : {}),
    }
    nodes[id] = node
    writeNodes(projectDir, nodes)
    return node
  })
}
