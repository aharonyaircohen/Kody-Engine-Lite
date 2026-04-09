/**
 * Write helpers for the graph store.
 *
 * - factExists   — check if a currently-valid fact with identical hall+room+content exists
 * - inferRoom    — extract a room slug from a list of file paths
 * - writeFactOnce — write only if not already present (dedup)
 */

import { getCurrentFacts } from "./queries.js"
import { writeFact } from "./queries.js"
import type { HallType, GraphNode } from "./types.js"

/**
 * Returns true if a currently-valid fact with identical hall + room + content exists.
 */
export function factExists(
  projectDir: string,
  hall: HallType,
  room: string,
  content: string,
): boolean {
  const candidates = getCurrentFacts(projectDir, hall, room)
  const normalized = content.toLowerCase().trim()
  return candidates.some(
    (n) => n.content.toLowerCase().trim() === normalized,
  )
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
 */
export function writeFactOnce(
  projectDir: string,
  hall: HallType,
  room: string,
  content: string,
  episodeId: string,
): GraphNode | null {
  if (factExists(projectDir, hall, room, content)) {
    return null
  }
  return writeFact(projectDir, hall, room, content, episodeId)
}
