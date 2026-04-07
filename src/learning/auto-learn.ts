import * as fs from "fs"
import * as path from "path"

import type { PipelineContext } from "../types.js"
import { logger } from "../logger.js"
import { detectArchitectureBasic } from "../bin/architecture-detection.js"
import { inferRoomsFromScope } from "../context-tiers.js"

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

const MAX_ENTRIES_PER_FILE = 40
const KEEP_ENTRIES_AFTER_PRUNE = 25

// ─── Dedup + Prune ──────────────────────────────────────────────────────────

/**
 * Filter out learnings that already exist in the target file.
 */
function dedup(learnings: string[], filePath: string): string[] {
  if (!fs.existsSync(filePath)) return learnings
  const existing = fs.readFileSync(filePath, "utf-8")
  return learnings.filter((l) => !existing.includes(l))
}

/**
 * Prune old entries if file exceeds MAX_ENTRIES_PER_FILE sections.
 * Keeps the most recent KEEP_ENTRIES_AFTER_PRUNE sections.
 */
function pruneIfNeeded(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  const content = fs.readFileSync(filePath, "utf-8")
  const sections = content.split(/\n(?=## Learned )/)
  if (sections.length <= MAX_ENTRIES_PER_FILE) return

  // Keep header (first section if it doesn't start with "## Learned")
  const header = sections[0].startsWith("## Learned") ? "" : sections[0]
  const entries = sections.filter((s) => s.startsWith("## Learned"))
  const kept = entries.slice(-KEEP_ENTRIES_AFTER_PRUNE)
  fs.writeFileSync(filePath, header + kept.join("\n"))
  logger.info(`Pruned conventions: ${entries.length} → ${kept.length} entries`)
}

// ─── Scope / Room ───────────────────────────────────────────────────────────

function getPrimaryRoom(ctx: PipelineContext): string | null {
  const taskJsonPath = path.join(ctx.taskDir, "task.json")
  if (!fs.existsSync(taskJsonPath)) return null
  try {
    const raw = stripAnsi(fs.readFileSync(taskJsonPath, "utf-8"))
    const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const task = JSON.parse(cleaned)
    const scope: string[] = Array.isArray(task.scope) ? task.scope : []
    const rooms = inferRoomsFromScope(scope)
    if (!rooms || rooms.length === 0) return null
    // Pick room with most files in scope
    const counts = new Map<string, number>()
    for (const filePath of scope) {
      const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean)
      const meaningful = parts.filter((p) => p !== "src" && p !== "lib" && p !== "app" && !p.includes("."))
      if (meaningful.length > 0) {
        const room = meaningful[0].toLowerCase()
        counts.set(room, (counts.get(room) ?? 0) + 1)
      }
    }
    let best = rooms[0]
    let bestCount = 0
    for (const [room, count] of counts) {
      if (count > bestCount) { best = room; bestCount = count }
    }
    return best
  } catch {
    return null
  }
}

// ─── Extraction ─────────────────────────────────────────────────────────────

function extractFromVerify(taskDir: string): string[] {
  const verifyPath = path.join(taskDir, "verify.md")
  if (!fs.existsSync(verifyPath)) return []
  const verify = stripAnsi(fs.readFileSync(verifyPath, "utf-8"))
  const learnings: string[] = []

  // Tool detection
  if (/vitest/i.test(verify)) learnings.push("- Uses vitest for testing")
  if (/jest/i.test(verify)) learnings.push("- Uses jest for testing")
  if (/eslint/i.test(verify)) learnings.push("- Uses eslint for linting")
  if (/prettier/i.test(verify)) learnings.push("- Uses prettier for formatting")
  if (/tsc\b/i.test(verify)) learnings.push("- Uses TypeScript (tsc)")
  if (/jsdom/i.test(verify)) learnings.push("- Test environment: jsdom")
  if (/node/i.test(verify) && /environment/i.test(verify)) learnings.push("- Test environment: node")

  // Pre-existing failure signatures
  if (/pre-existing/i.test(verify)) {
    const match = verify.match(/pre-existing.*?(\S+\.test\.\S+)/i)
    if (match) learnings.push(`- Pre-existing test failure: ${match[1]}`)
  }

  // Coverage info
  const coverageMatch = verify.match(/(\d+(?:\.\d+)?)\s*%\s*(?:coverage|statements|branches)/i)
  if (coverageMatch) learnings.push(`- Test coverage: ~${coverageMatch[1]}%`)

  return learnings
}

function extractFromReview(taskDir: string): string[] {
  const reviewPath = path.join(taskDir, "review.md")
  if (!fs.existsSync(reviewPath)) return []
  const review = fs.readFileSync(reviewPath, "utf-8")
  const learnings: string[] = []

  if (/\.js extension/i.test(review)) learnings.push("- Imports use .js extensions (ESM)")
  if (/barrel export/i.test(review)) learnings.push("- Uses barrel exports (index.ts)")
  if (/timezone/i.test(review)) learnings.push("- Timezone handling is a concern in this codebase")
  if (/UTC/i.test(review)) learnings.push("- Date operations should consider UTC vs local time")
  if (/path alias|@\//i.test(review)) learnings.push("- Uses @/ path aliases for imports")
  if (/use client/i.test(review)) learnings.push("- Client components require 'use client' directive")

  return learnings
}

function extractFromContext(taskDir: string): string[] {
  const contextPath = path.join(taskDir, "context.md")
  if (!fs.existsSync(contextPath)) return []
  const context = fs.readFileSync(contextPath, "utf-8")
  const learnings: string[] = []

  if (/zod/i.test(context) && /schema|validate/i.test(context)) learnings.push("- Uses Zod for validation")
  if (/prisma/i.test(context)) learnings.push("- Uses Prisma ORM")
  if (/drizzle/i.test(context)) learnings.push("- Uses Drizzle ORM")
  if (/payload/i.test(context) && /collection/i.test(context)) learnings.push("- Uses Payload CMS collections")

  return learnings
}

function extractDirectories(ctx: PipelineContext): string[] {
  const taskJsonPath = path.join(ctx.taskDir, "task.json")
  if (!fs.existsSync(taskJsonPath)) return []
  try {
    const raw = stripAnsi(fs.readFileSync(taskJsonPath, "utf-8"))
    const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const task = JSON.parse(cleaned)
    if (task.scope && Array.isArray(task.scope)) {
      const dirs = [...new Set(task.scope.map((s: string) => s.split("/").slice(0, -1).join("/")).filter(Boolean))]
      if (dirs.length > 0) return [`- Active directories: ${dirs.join(", ")}`]
    }
  } catch { /* ignore */ }
  return []
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function autoLearn(ctx: PipelineContext): void {
  try {
    const memoryDir = path.join(ctx.projectDir, ".kody", "memory")
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true })
    }

    const timestamp = new Date().toISOString().slice(0, 10)
    const room = getPrimaryRoom(ctx)

    // Collect learnings from all sources
    const globalLearnings = [
      ...extractFromVerify(ctx.taskDir),
      ...extractFromContext(ctx.taskDir),
    ]
    const reviewLearnings = extractFromReview(ctx.taskDir)
    const dirLearnings = extractDirectories(ctx)

    // Global conventions go to conventions.md
    const globalPath = path.join(memoryDir, "conventions.md")
    const allGlobal = [...globalLearnings, ...reviewLearnings, ...dirLearnings]
    const newGlobal = dedup(allGlobal, globalPath)
    if (newGlobal.length > 0) {
      const entry = `\n## Learned ${timestamp} (task: ${ctx.taskId})\n${newGlobal.join("\n")}\n`
      fs.appendFileSync(globalPath, entry)
      pruneIfNeeded(globalPath)
      logger.info(`Auto-learned ${newGlobal.length} convention(s)`)
    }

    // Room-specific conventions go to conventions_{room}.md
    if (room && reviewLearnings.length > 0) {
      const roomPath = path.join(memoryDir, `conventions_${room}.md`)
      const newRoom = dedup(reviewLearnings, roomPath)
      if (newRoom.length > 0) {
        const entry = `\n## Learned ${timestamp} (task: ${ctx.taskId})\n${newRoom.join("\n")}\n`
        fs.appendFileSync(roomPath, entry)
        pruneIfNeeded(roomPath)
        logger.info(`Auto-learned ${newRoom.length} convention(s) for room: ${room}`)
      }
    }

    // Auto-detect architecture (only if architecture.md doesn't exist)
    autoLearnArchitecture(ctx.projectDir, memoryDir, timestamp)
  } catch {
    // Auto-learn is best-effort — don't fail the pipeline
  }
}

function autoLearnArchitecture(
  projectDir: string,
  memoryDir: string,
  timestamp: string,
): void {
  // Support both legacy "architecture.md" and new hall-prefixed "facts_architecture.md"
  const legacyPath = path.join(memoryDir, "architecture.md")
  const hallPath = path.join(memoryDir, "facts_architecture.md")
  if (fs.existsSync(legacyPath) || fs.existsSync(hallPath)) return

  const detected = detectArchitectureBasic(projectDir)
  if (detected.length > 0) {
    const content = `# Architecture (auto-detected ${timestamp})\n\n## Overview\n${detected.join("\n")}\n`
    fs.writeFileSync(hallPath, content)
    logger.info(`Auto-detected architecture (${detected.length} items)`)
  }
}
