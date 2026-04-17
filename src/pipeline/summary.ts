import type { PipelineStatus } from "../types.js"
import { STAGES } from "../definitions.js"

export interface SummaryOptions {
  complexity?: string
  model?: string
  runCount?: number
}

const STATUS_ICONS: Record<string, string> = {
  completed: "completed",
  failed: "failed",
  timeout: "timeout",
  running: "running",
  pending: "pending",
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m ${sec}s`
}

function stageDuration(stage: { startedAt?: string; completedAt?: string }): string {
  if (!stage.startedAt) return "-"
  const start = new Date(stage.startedAt).getTime()
  const end = stage.completedAt
    ? new Date(stage.completedAt).getTime()
    : Date.now()
  if (isNaN(start) || isNaN(end)) return "-"
  return formatDuration(end - start)
}

export function formatPipelineSummary(
  state: PipelineStatus,
  options?: SummaryOptions,
): string {
  const lines: string[] = []

  lines.push(`## Pipeline Summary: \`${state.taskId}\``)
  lines.push("")
  lines.push("| Stage | Status | Duration | Retries |")
  lines.push("|-------|--------|----------|---------|")

  for (const def of STAGES) {
    const s = state.stages[def.name]
    if (!s) continue
    const baseStatus = STATUS_ICONS[s.state] ?? s.state
    // Surface the granular category on failed/timeout rows so the reader
    // can distinguish real timeouts from exhausted limits at a glance.
    const status = s.failureCategory && (s.state === "failed" || s.state === "timeout")
      ? `${baseStatus} (${s.failureCategory})`
      : baseStatus
    const duration = stageDuration(s)
    const retries = s.retries ?? 0
    lines.push(`| ${def.name} | ${status} | ${duration} | ${retries} |`)
  }

  // Total duration from createdAt to updatedAt
  const totalMs = new Date(state.updatedAt).getTime() - new Date(state.createdAt).getTime()
  const totalStr = isNaN(totalMs) || totalMs < 0 ? "-" : formatDuration(totalMs)

  lines.push("")

  const footerParts = [`**Total:** ${totalStr}`]
  if (options?.complexity) {
    footerParts.push(`**Complexity:** ${options.complexity}`)
  }
  if (options?.model) {
    footerParts.push(`**Model:** ${options.model}`)
  }

  if (options?.runCount && options.runCount > 1) {
    footerParts.push(`**Run:** #${options.runCount} of ${options.runCount} attempts`)
  }

  lines.push(footerParts.join(" | "))

  return lines.join("\n")
}
