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

/**
 * Extract patterns from build stage output.
 */
function extractBuildPatterns(taskDir: string): string[] {
  const contextPath = path.join(taskDir, "context.md")
  if (!fs.existsSync(contextPath)) return []
  const context = fs.readFileSync(contextPath, "utf-8")
  const patterns: string[] = []

  // File creation patterns
  const created = context.match(/(?:created?|wrote|added)\s+(\S+\.\w+)/gi)
  if (created) {
    const files = created.map((m) => m.replace(/^(?:created?|wrote|added)\s+/i, "")).slice(0, 5)
    patterns.push(`files.created:${files.join(",")}`)
  }

  // Import patterns observed
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
 * Extract patterns from review stage output.
 */
function extractReviewPatterns(taskDir: string): string[] {
  const reviewPath = path.join(taskDir, "review.md")
  const review = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, "utf-8") : ""
  const patterns: string[] = []

  // Verdict
  if (/verdict.*pass/i.test(review)) patterns.push("verdict:PASS")
  if (/verdict.*fail/i.test(review)) patterns.push("verdict:FAIL")

  // Common findings from review
  if (/error handling/i.test(review)) patterns.push("finding:error-handling")
  if (/type safety|type assertion|as unknown/i.test(review)) patterns.push("finding:type-safety")
  if (/test coverage|missing test/i.test(review)) patterns.push("finding:test-coverage")
  if (/security|injection|xss|csrf/i.test(review)) patterns.push("finding:security")
  if (/naming|convention/i.test(review)) patterns.push("finding:naming-convention")

  // Also extract investigation facts from context.md
  patterns.push(...extractInvestigationFacts(taskDir))

  return patterns
}

/**
 * Extract concrete investigation facts from context.md.
 * These capture what was found, fixed, and confirmed — not just generic verdict tags.
 */
function extractInvestigationFacts(taskDir: string): string[] {
  const contextPath = path.join(taskDir, "context.md")
  if (!fs.existsSync(contextPath)) return []
  const context = fs.readFileSync(contextPath, "utf-8")
  const facts: string[] = []

  // Route count — "5 routes" / "N routes investigated"
  const routeMatch = context.match(/(\d+)\s+(?:routes?|endpoints?)/i)
  if (routeMatch) facts.push(`investigation:${routeMatch[1]}-routes-flagged`)

  // What was fixed — extract endpoint name and auth change
  // e.g. "copilotkit/route.ts" + "auth: 'public'" → "fix:copilotkit-GET-auth-public"
  const fixMatch = context.match(/fixed[:\s]+.*?[\/`'"](\w+)[\/`'"].*?(?:auth[:\s]+['"](\w+)['"]|wrapped with)/i)
  if (fixMatch) {
    const endpoint = fixMatch[1].toLowerCase()
    const authLevel = fixMatch[2]?.toLowerCase()
    facts.push(authLevel ? `fix:${endpoint}-auth-${authLevel}` : `fix:${endpoint}`)
  }

  // Explicit "was wrapped with" patterns (e.g. withApiHandler)
  const wrappedMatch = context.match(/wrapped with.*?[\`'"](\w+)[\`'"].*?(?:auth[:\s]+['"](\w+)['"])/i)
  if (wrappedMatch) {
    facts.push(wrappedMatch[2] ? `fix:endpoint-auth-${wrappedMatch[2].toLowerCase()}` : `fix:endpoint-auth`)
  }

  // Auth level anywhere in context (e.g. "auth: 'public'" or "auth: 'authenticated'")
  const authMatch = context.match(/auth[:=\s]+['"]?(\w+)['"]?/i)
  if (authMatch) {
    facts.push(`auth:${authMatch[1].toLowerCase()}`)
  }

  // Confirmation that other things were already correct
  const confirmed = context.match(/(?:already|was|were)\s+(?:correct|protected|fixed|done)\b/gi)
  if (confirmed && confirmed.length > 0) {
    facts.push(`confirmed:${confirmed.length}-items-already-correct`)
  }

  // "Already protected" / "already had auth" patterns
  if (/already (?:properly )?(?:protected|has auth|had auth|done)/i.test(context)) {
    facts.push("confirmed:existing-protection")
  }

  // Scanner source (if mentioned)
  if (/security.?scan|scanner|github.?secret/i.test(context)) {
    facts.push("source:security-scanner")
  }

  // Specific vulnerability types
  if (/missing auth|without auth|unauthenticated/i.test(context)) {
    facts.push("finding:missing-auth")
  }
  if (/unprotected route|no auth on/i.test(context)) {
    facts.push("finding:unprotected-route")
  }
  if (/get handler.*no auth|get.*without/i.test(context)) {
    facts.push("finding:get-handler-no-auth")
  }

  // API route patterns
  if (/api\/.*route/i.test(context)) {
    facts.push("scope:api-route")
  }

  // GET vs POST distinction
  if (/\bGET\b.*(?:handler|route)/i.test(context)) {
    facts.push("handler:GET")
  }

  return facts
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
