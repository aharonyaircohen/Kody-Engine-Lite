/**
 * Stage Diary — persistent per-stage memory across runs.
 *
 * Each pipeline stage (build, verify, review) maintains a diary of patterns
 * it encounters. Over time, stages accumulate domain expertise about the
 * codebase, reducing rediscovery on each run.
 *
 * Storage: .kody/memory/diary_{stage}.jsonl
 * Format: one JSON entry per line, AAAK-compressed patterns.
 */

import * as fs from "fs"
import * as path from "path"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiaryEntry {
  taskId: string
  timestamp: string
  stage: string
  patterns: string[]   // compressed observations
  room?: string        // codebase area (from task scope)
}

// ─── Storage ────────────────────────────────────────────────────────────────

const MAX_DIARY_ENTRIES = 30

function getDiaryPath(projectDir: string, stage: string): string {
  return path.join(projectDir, ".kody", "memory", `diary_${stage}.jsonl`)
}

/**
 * Read recent diary entries for a stage.
 */
export function readDiary(projectDir: string, stage: string, limit = 5): DiaryEntry[] {
  const filePath = getDiaryPath(projectDir, stage)
  if (!fs.existsSync(filePath)) return []

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n").filter(Boolean)
    const entries: DiaryEntry[] = []

    const start = Math.max(0, lines.length - limit)
    for (let i = start; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]))
      } catch {
        // Skip malformed lines
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Append a diary entry for a stage. Auto-prunes old entries.
 */
export function appendDiary(projectDir: string, entry: DiaryEntry): void {
  const filePath = getDiaryPath(projectDir, entry.stage)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n")

  // Prune if too many entries
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n").filter(Boolean)
    if (lines.length > MAX_DIARY_ENTRIES) {
      const kept = lines.slice(-MAX_DIARY_ENTRIES)
      fs.writeFileSync(filePath, kept.join("\n") + "\n")
    }
  } catch {
    // Best effort
  }
}

// ─── Pattern Extraction ─────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

// ─── Domain Classification ────────────────────────────────────────────────────

const DOMAIN_KEYWORDS: Array<[RegExp[], string]> = [
  [[/\bsecurity\b/i, /\bxss\b/i, /\binjection\b/i, /\bcsrf\b/i, /\bauth\b/i, /\bauthn\b/i, /\bauthz\b/i], "domain:security"],
  [[/\bbug\b/i, /\bfix\b/i, /\bbroken\b/i, /\bcrash\b/i, /\berror\b/i, /\bfails?\b/i], "domain:bugfix"],
  [[/\brefactor\b/i, /\brestructure\b/i, /\bcleanup\b/i, /\brewrite\b/i], "domain:refactor"],
  [[/\bdocs?\b/i, /\breadme\b/i, /\bcomment\b/i, /\bchangelog\b/i], "domain:docs"],
  [[/\bfeature\b/i, /\badd\b/i, /\bimplement\b/i, /\bnew\b/i, /\benhancement\b/i], "domain:feature"],
]

function classifyDomain(text: string): string | null {
  for (const [keywords, label] of DOMAIN_KEYWORDS) {
    if (keywords.some((r) => r.test(text))) return label
  }
  return null
}

// ─── File Scope Extraction ───────────────────────────────────────────────────

/**
 * Extract meaningful file/directory scope from context.md.
 * Picks unique top-level segments to avoid noise while staying specific.
 * e.g. "scripts/inspector/plugins/project/security-scanner/rules.ts" → "scripts/inspector/..."
 */
function extractFileScope(taskDir: string): string | null {
  const contextPath = path.join(taskDir, "context.md")
  if (!fs.existsSync(contextPath)) return null
  const content = fs.readFileSync(contextPath, "utf-8")

  const filePaths = content.match(/[\w./\\-]+\.(ts|tsx|js|jsx|json|md|yml|yaml|sql)/gi)
  if (!filePaths || filePaths.length === 0) return null

  // Deduplicate and compress to top-3 most specific unique directories
  const dirs = new Set<string>()
  for (const fp of filePaths) {
    const normalized = fp.replace(/\\/g, "/")
    const parts = normalized.split("/").filter(Boolean)
    // Take first 2 meaningful segments (skip "src", "lib", "app")
    const meaningful = parts.filter((p) => p !== "src" && p !== "lib" && p !== "app" && !p.startsWith("."))
    if (meaningful.length >= 2) {
      dirs.add(meaningful.slice(0, 2).join("/"))
    } else if (meaningful.length === 1) {
      dirs.add(meaningful[0])
    }
  }
  if (dirs.size === 0) return null
  const top = [...dirs].slice(0, 3)
  return `files:${top.join(",")}`
}

/**
 * Extract a short fix descriptor from plan.md.
 * Prioritizes added diff lines (+ lines = actual new code) over descriptions.
 */
function extractFixDescriptor(taskDir: string): string | null {
  const planPath = path.join(taskDir, "plan.md")
  if (!fs.existsSync(planPath)) return null
  const plan = fs.readFileSync(planPath, "utf-8")
  const lines = plan.split("\n").map((l) => l.trim()).filter(Boolean)

  // First pass: added diff lines (+ prefix = new code, most specific)
  for (const line of lines) {
    if (/^\+/.test(line) && !/^\+\+\+/.test(line)) {
      const cleaned = line.replace(/^\+/, "").trim()
      if (cleaned.length > 0 && cleaned.length < 80) {
        return `fix:${cleaned.replace(/\s+/g, " ").slice(0, 50)}`
      }
    }
  }

  // Second pass: removed diff lines (- prefix)
  for (const line of lines) {
    if (/^-/.test(line) && !/^---/.test(line)) {
      const cleaned = line.replace(/^-/, "").trim()
      if (cleaned.length > 0 && cleaned.length < 80) {
        return `fix:${cleaned.replace(/\s+/g, " ").slice(0, 50)}`
      }
    }
  }

  // Fall back to first non-header description line
  for (const line of lines) {
    if (!line.startsWith("#") && line.length > 10 && line.length < 120) {
      return `fix:${line.slice(0, 60)}`
    }
  }
  return null
}

/**
 * Extract patterns from build stage output.
 */
export function extractBuildPatterns(taskDir: string): string[] {
  const contextPath = path.join(taskDir, "context.md")
  if (!fs.existsSync(contextPath)) return []
  const context = fs.readFileSync(contextPath, "utf-8")
  const patterns: string[] = []

  // File creation patterns — what was actually built
  const created = context.match(/(?:created?|wrote|added)\s+([^\s]+)/gi)
  if (created) {
    const files = created
      .map((m) => m.replace(/^(?:created?|wrote|added)\s+/i, ""))
      .filter((f) => f.includes("."))
      .slice(0, 5)
    if (files.length > 0) patterns.push(`files.created:${files.join(",")}`)
  }

  // Import patterns observed in context
  if (/@\//i.test(context)) patterns.push("imports:path-alias(@/)")
  if (/\.js['"]|\.js extension/i.test(context)) patterns.push("imports:explicit-js-ext")
  if (/from ['"]\.{1,2}\//i.test(context)) patterns.push("imports:relative-paths")

  return patterns
}

/**
 * Extract patterns from verify stage output.
 */
function extractVerifyPatterns(taskDir: string): string[] {
  const verifyPath = path.join(taskDir, "verify.md")
  if (!fs.existsSync(verifyPath)) return []
  const verify = stripAnsi(fs.readFileSync(verifyPath, "utf-8"))
  const patterns: string[] = []

  // Pre-existing failures
  if (/pre-existing/i.test(verify)) {
    const match = verify.match(/pre-existing.*?(\S+\.test\.\S+)/i)
    patterns.push(match ? `preexisting.fail:${match[1]}` : "preexisting.fail.detected")
  }

  // Test results summary
  const passMatch = verify.match(/(\d+)\s+(?:tests?\s+)?pass/i)
  const failMatch = verify.match(/(\d+)\s+(?:tests?\s+)?fail/i)
  if (passMatch || failMatch) {
    const pass = passMatch?.[1] ?? "?"
    const fail = failMatch?.[1] ?? "0"
    patterns.push(`tests:${pass}pass.${fail}fail`)
  }

  // Typecheck result
  if (/tsc.*(?:error|found \d+ error)/i.test(verify)) patterns.push("tsc:errors.found")
  if (/tsc.*no error|typecheck.*pass/i.test(verify)) patterns.push("tsc:clean")

  // Lint result
  if (/eslint.*\d+ error/i.test(verify)) patterns.push("lint:errors.found")
  if (/lint.*pass|0 error/i.test(verify)) patterns.push("lint:clean")

  return patterns
}

/**
 * Extract patterns from review stage — driven by task context, not keyword scraping.
 *
 * Uses the actual task files (task.md, context.md, plan.md) which contain
 * ground-truth information about what was worked on. The review.md verdict
 * is used only to confirm PASS/FAIL, not to guess findings.
 */
function extractReviewPatterns(taskDir: string): string[] {
  const taskPath = path.join(taskDir, "task.md")
  const reviewPath = path.join(taskDir, "review.md")
  const patterns: string[] = []

  // 1. Verdict — only reliable thing from review.md
  if (fs.existsSync(reviewPath)) {
    const review = fs.readFileSync(reviewPath, "utf-8")
    if (/verdict.*pass/i.test(review)) patterns.push("verdict:PASS")
    else if (/verdict.*fail/i.test(review)) patterns.push("verdict:FAIL")
  }

  // 2. Domain — from task description (ground truth about what this issue is)
  if (fs.existsSync(taskPath)) {
    const task = fs.readFileSync(taskPath, "utf-8")
    const domain = classifyDomain(task)
    if (domain) patterns.push(domain)
  }

  // 3. File scope — from context.md (what files were in scope for this task)
  const fileScope = extractFileScope(taskDir)
  if (fileScope) patterns.push(fileScope)

  // 4. Fix descriptor — from plan.md (what specifically was changed)
  const fixDesc = extractFixDescriptor(taskDir)
  if (fixDesc) patterns.push(fixDesc)

  return patterns
}

/**
 * Extract patterns from a completed stage.
 * Returns empty array for stages without meaningful pattern data.
 */
export function extractStagePatterns(stageName: string, taskDir: string): string[] {
  switch (stageName) {
    case "build":
    case "review-fix":
      return extractBuildPatterns(taskDir)
    case "verify":
      return extractVerifyPatterns(taskDir)
    case "review":
      return extractReviewPatterns(taskDir)
    default:
      return []
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format diary entries as compressed context for prompt injection.
 */
export function formatDiaryForPrompt(entries: DiaryEntry[]): string {
  if (entries.length === 0) return ""

  const lines: string[] = [`STAGE_DIARY|${entries.length}entries`]
  for (const entry of entries) {
    const taskShort = entry.taskId.slice(0, 12)
    const date = entry.timestamp.slice(0, 10)
    const room = entry.room ? `@${entry.room}` : ""
    const patterns = entry.patterns.join("|")
    lines.push(`${date}:${taskShort}${room}|${patterns}`)
  }

  return lines.join("\n")
}
