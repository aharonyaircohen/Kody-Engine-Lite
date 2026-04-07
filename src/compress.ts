/**
 * AAAK-inspired compression for memory and context.
 *
 * Converts structured text (markdown, key-value) into a compact shorthand
 * that LLMs can read natively. Targets ~3-5x token reduction while
 * preserving all semantic content.
 */

// ─── Run History Compression ───────────────────────────────────────────────

import type { RunRecord } from "./run-history.js"

/**
 * Compress a single RunRecord into AAAK-style shorthand.
 *
 *   R1:abc123(run)FAIL@verify|err:tests.3errors|done:taskify,plan,build
 */
export function compressRunRecord(record: RunRecord, index: number): string {
  const id = record.runId.slice(0, 8)
  const outcome = record.outcome === "completed"
    ? "OK"
    : record.failedStage
      ? `FAIL@${record.failedStage}`
      : "FAIL"

  const parts: string[] = [`R${index}:${id}(${record.command})${outcome}`]

  if (record.failedError) {
    // Compress error: lowercase, dots instead of spaces, truncate
    const err = record.failedError
      .slice(0, 80)
      .toLowerCase()
      .replace(/\s+/g, ".")
      .replace(/[^a-z0-9._-]/g, "")
    parts.push(`err:${err}`)
  }

  if (record.stagesCompleted.length > 0) {
    const allStages = ["taskify", "plan", "build", "verify", "review", "review-fix", "ship"]
    const done = record.stagesCompleted
    if (done.length === allStages.length) {
      parts.push("done:all")
    } else {
      parts.push(`done:${done.join(",")}`)
    }
  }

  if (record.feedback) {
    const fb = record.feedback.slice(0, 60).replace(/\n/g, " ")
    parts.push(`fb:"${fb}"`)
  }

  return parts.join("|")
}

/**
 * Compress full run history into AAAK-style block.
 */
export function compressRunHistory(records: RunRecord[], maxRuns = 5): string {
  if (records.length === 0) return ""

  const recent = records.slice(-maxRuns)
  const lines: string[] = [`PREV_RUNS|${records.length}total`]

  for (let i = 0; i < recent.length; i++) {
    const globalIndex = records.length - recent.length + i + 1
    lines.push(compressRunRecord(recent[i], globalIndex))
  }

  return lines.join("\n")
}

// ─── Contradiction Detection ───────────────────────────────────────────────

export interface Contradiction {
  type: "repeat_fail" | "approach_loop" | "feedback_ignored"
  message: string
}

/**
 * Detect contradictions and anti-patterns in run history.
 * Pure data analysis — no LLM needed.
 */
export function detectContradictions(records: RunRecord[]): Contradiction[] {
  if (records.length < 2) return []

  const contradictions: Contradiction[] = []
  const failedRuns = records.filter((r) => r.outcome === "failed")

  // 1. Repeated failure at same stage
  const stageFailCounts = new Map<string, number>()
  for (const r of failedRuns) {
    if (r.failedStage) {
      stageFailCounts.set(r.failedStage, (stageFailCounts.get(r.failedStage) ?? 0) + 1)
    }
  }
  for (const [stage, count] of stageFailCounts) {
    if (count >= 2) {
      contradictions.push({
        type: "repeat_fail",
        message: `!REPEAT_FAIL@${stage}(${count}x)|approach.fundamentally.wrong`,
      })
    }
  }

  // 2. Approach loop: identical stagesCompleted sequence across failed runs
  const sequences = failedRuns.map((r) => r.stagesCompleted.join(","))
  const seqCounts = new Map<string, number>()
  for (const seq of sequences) {
    if (seq) seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1)
  }
  for (const [seq, count] of seqCounts) {
    if (count >= 2) {
      contradictions.push({
        type: "approach_loop",
        message: `!LOOP:${seq}→FAIL(${count}x)|try.different.strategy`,
      })
    }
  }

  // 3. Feedback ignored: feedback given but next run fails at same stage
  for (let i = 0; i < records.length - 1; i++) {
    const current = records[i]
    const next = records[i + 1]
    if (
      current.feedback &&
      current.outcome === "failed" &&
      next.outcome === "failed" &&
      current.failedStage &&
      current.failedStage === next.failedStage
    ) {
      const fb = current.feedback.slice(0, 40).replace(/\n/g, " ")
      contradictions.push({
        type: "feedback_ignored",
        message: `!FB_IGNORED:"${fb}"|still.fail@${current.failedStage}`,
      })
    }
  }

  return contradictions
}

/**
 * Format contradictions as warning block for prompt injection.
 */
export function formatContradictions(contradictions: Contradiction[]): string {
  if (contradictions.length === 0) return ""
  return contradictions.map((c) => c.message).join("\n")
}

// ─── Memory Compression ───────────────────────────────────────────────────

/**
 * Compress a markdown memory file into AAAK-style shorthand.
 * Handles key-value lists, headings, and bullet points.
 */
export function compressMemoryContent(content: string, filename: string): string {
  if (!content.trim()) return ""

  const lines = content.split("\n")
  const parts: string[] = []
  const prefix = filename.replace(/\.md$/, "").toUpperCase()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Skip headings — fold into prefix
    if (trimmed.startsWith("#")) continue

    // Key-value patterns: "- Framework: Next.js 14"
    const kvMatch = trimmed.match(/^[-*]\s*(.+?):\s*(.+)$/)
    if (kvMatch) {
      const key = kvMatch[1].toLowerCase().replace(/\s+/g, "_")
      const val = kvMatch[2].trim()
      parts.push(`${key}:${val}`)
      continue
    }

    // Simple bullets: "- Uses vitest for testing"
    const bulletMatch = trimmed.match(/^[-*]\s*(.+)$/)
    if (bulletMatch) {
      const val = bulletMatch[1]
        .replace(/^Uses\s+/i, "")
        .replace(/\s+for\s+/g, "→")
        .replace(/\s+/g, ".")
      parts.push(val)
      continue
    }

    // Plain text: compress whitespace
    parts.push(trimmed.replace(/\s+/g, ".").slice(0, 60))
  }

  if (parts.length === 0) return ""
  return `${prefix}|${parts.join("|")}`
}
