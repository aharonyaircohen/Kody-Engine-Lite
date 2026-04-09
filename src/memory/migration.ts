/**
 * Migration from legacy .md file memory to flat-file graph.
 *
 * Non-destructive: reads .md files, writes to graph, leaves .md files intact.
 */

import * as fs from "fs"
import * as path from "path"
import { ensureGraphDir } from "./graph/store.js"
import { createEpisode } from "./graph/episode.js"
import { writeFact } from "./graph/queries.js"
import { HallTypeValues } from "./graph/types.js"

interface MigrationResult {
  migrated: number
  skipped: number
  errors: string[]
}

// ─── Project Memory Migration ──────────────────────────────────────────────────

const HALL_PREFIXES = HallTypeValues as readonly string[]

function inferHallFromFilename(filename: string): { hall: string; room: string | null } {
  const base = filename.replace(/\.md$/, "")
  for (const prefix of HALL_PREFIXES) {
    if (base.startsWith(`${prefix}_`)) {
      const room = base.slice(prefix.length + 1)
      return { hall: prefix, room: room || null }
    }
  }
  return { hall: "", room: null }
}

/**
 * Migrate all .kody/memory/*.md files to the graph store.
 */
export async function migrateProjectMemory(
  projectDir: string,
): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] }

  const memoryDir = path.join(projectDir, ".kody", "memory")
  if (!fs.existsSync(memoryDir)) return result

  const files = fs.readdirSync(memoryDir).filter(f => f.endsWith(".md"))
  if (files.length === 0) return result

  ensureGraphDir(projectDir)

  // Create a migration episode once for all files
  const episode = await createEpisode(projectDir, {
    runId: "migration",
    source: "migration",
    taskId: "migration",
    createdAt: new Date().toISOString(),
    rawContent: `Migrating ${files.length} legacy .md memory files`,
    extractedNodeIds: [],
  })

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(memoryDir, file), "utf-8").trim()
      if (!content) {
        result.skipped++
        continue
      }

      const { hall, room } = inferHallFromFilename(file)

      // If no recognized hall prefix, treat whole filename as room, default to conventions
      const resolvedHall = hall || "conventions"
      const resolvedRoom = room || file.replace(/\.md$/, "")

      // Split content into individual entries (one per bullet point)
      const lines = content.split("\n")
      let entryCount = 0

      for (const line of lines) {
        const trimmed = line.trim()
        // Match lines starting with "- " or "* " (bullet points)
        const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/)
        if (bulletMatch) {
          writeFact(projectDir, resolvedHall as typeof HallTypeValues[number], resolvedRoom, bulletMatch[1], episode.id)
          entryCount++
        }
      }

      if (entryCount === 0) {
        // Non-bullet content — migrate as single entry using first line
        const firstLine = lines[0]?.trim() || content
        writeFact(projectDir, resolvedHall as typeof HallTypeValues[number], resolvedRoom, firstLine, episode.id)
        entryCount++
      }

      result.migrated += entryCount
    } catch (err) {
      result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

// ─── Run History Migration ────────────────────────────────────────────────────

/**
 * Migrate .kody/run-history.json episodes to the graph.
 */
export async function migrateRunHistory(
  projectDir: string,
): Promise<{ migrated: number; errors: string[] }> {
  const result = { migrated: 0, errors: [] as string[] }

  const historyPath = path.join(projectDir, ".kody", "run-history.json")
  if (!fs.existsSync(historyPath)) return result

  try {
    const raw = fs.readFileSync(historyPath, "utf-8")
    const records = JSON.parse(raw) as Array<{
      id?: string
      runId?: string
      taskId?: string
      completedAt?: string
      summary?: string
      verdict?: string
    }>

    ensureGraphDir(projectDir)

    for (const record of records) {
      try {
        await createEpisode(projectDir, {
          runId: record.runId || record.id || "unknown",
          source: "migration",
          taskId: record.taskId || "unknown",
          createdAt: record.completedAt || new Date().toISOString(),
          rawContent: record.summary || record.verdict || "migrated run record",
          extractedNodeIds: [],
        })
        result.migrated++
      } catch (err) {
        result.errors.push(`${record.runId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    result.errors.push(`run-history.json: ${err instanceof Error ? err.message : String(err)}`)
  }

  return result
}
