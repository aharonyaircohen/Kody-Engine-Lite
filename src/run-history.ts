import * as fs from "fs"
import * as path from "path"

import {
  compressRunHistory,
  detectContradictions,
  formatContradictions,
} from "./compress.js"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RunRecord {
  runId: string
  issueNumber?: number
  prNumber?: number
  command: string
  startedAt: string
  completedAt?: string
  outcome: "completed" | "failed" | "running"
  failedStage?: string
  failedError?: string
  stagesCompleted: string[]
  feedback?: string
  parentRunId?: string
  linkedIssue?: number
}

// ─── Storage ────────────────────────────────────────────────────────────────

function getRunHistoryPath(projectDir: string, issueNumber: number): string {
  return path.join(projectDir, ".kody", "runs", `${issueNumber}.jsonl`)
}

export function appendRunRecord(projectDir: string, record: RunRecord): void {
  const filePath = record.issueNumber
    ? getRunHistoryPath(projectDir, record.issueNumber)
    : path.join(projectDir, ".kody", "runs", `${record.runId}.jsonl`)

  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const line = JSON.stringify(record) + "\n"
  fs.appendFileSync(filePath, line, "utf-8")
}

export function readRunHistory(projectDir: string, issueNumber: number): RunRecord[] {
  const filePath = getRunHistoryPath(projectDir, issueNumber)
  if (!fs.existsSync(filePath)) return []

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n").filter(Boolean)
    const records: RunRecord[] = []

    for (const line of lines) {
      try {
        records.push(JSON.parse(line))
      } catch {
        // Skip malformed lines
      }
    }

    return records
  } catch {
    return []
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatRunHistoryForPrompt(records: RunRecord[], maxRuns = 5): string {
  if (records.length === 0) return ""

  const recent = records.slice(-maxRuns)
  const lines: string[] = [
    "## Previous Runs on This Issue",
    "",
  ]

  for (let i = 0; i < recent.length; i++) {
    const r = recent[i]
    const runNum = records.length - recent.length + i + 1
    const failInfo = r.failedStage ? ` — failed at ${r.failedStage}` : ""
    const outcomeLabel = r.outcome === "completed" ? " — completed" : failInfo

    lines.push(`### Run ${runNum}: ${r.runId} (${r.command})${outcomeLabel}`)

    if (r.failedError) {
      lines.push(`Error: ${r.failedError}`)
    }

    if (r.stagesCompleted.length > 0) {
      lines.push(`Stages completed: ${r.stagesCompleted.join(", ")}`)
    }

    if (r.feedback) {
      lines.push(`Feedback: "${r.feedback.slice(0, 200)}"`)
    }

    lines.push("")
  }

  lines.push("IMPORTANT: Review what was tried before. Do NOT repeat failing approaches.")

  return lines.join("\n")
}

// ─── Compressed Format ──────────────────────────────────────────────────────

/**
 * AAAK-style compressed run history with contradiction detection.
 * ~65% fewer tokens than verbose markdown format.
 */
export function formatRunHistoryCompressed(records: RunRecord[], maxRuns = 5): string {
  if (records.length === 0) return ""

  const compressed = compressRunHistory(records, maxRuns)
  const contradictions = detectContradictions(records)
  const warnings = formatContradictions(contradictions)

  const parts = [compressed]
  if (warnings) {
    parts.push(warnings)
  }
  parts.push("!NO_REPEAT: Review runs above. Do NOT repeat failing approaches.")

  return parts.join("\n")
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function findParentRunId(projectDir: string, issueNumber: number): string | undefined {
  const records = readRunHistory(projectDir, issueNumber)
  if (records.length === 0) return undefined
  return records[records.length - 1].runId
}
