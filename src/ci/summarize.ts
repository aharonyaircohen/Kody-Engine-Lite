/**
 * Generates a GitHub Actions step summary from a task's status.json.
 *
 * Usage: kody-engine ci-summarize
 *
 * Env vars:
 *   TASK_ID    — task identifier (from pipeline run)
 *   GITHUB_STEP_SUMMARY — path to step summary file (set by Actions)
 *
 * Reads .kody/tasks/<TASK_ID>/status.json and appends a markdown table
 * to $GITHUB_STEP_SUMMARY.
 */

import * as fs from "fs"
import * as path from "path"

const STAGES = ["taskify", "plan", "build", "verify", "review", "review-fix", "ship"]

interface StageState {
  state: string
  error?: string
}

interface TaskStatus {
  state: "running" | "completed" | "failed"
  stages: Record<string, StageState>
}

const STATE_ICON: Record<string, string> = {
  completed: "✅",
  failed: "❌",
  timeout: "⏱",
  running: "▶️",
  pending: "○",
}

function iconForState(state: string): string {
  return STATE_ICON[state] ?? "○"
}

function padRight(s: string, n: number): string {
  return s.padEnd(n)
}

/**
 * Pure: generates markdown table from a TaskStatus object.
 */
export function summarizeTask(taskId: string, status: TaskStatus): string {
  const overallIcon = taskId ? (status.state === "completed" ? "✅" : "❌") : "○"
  const overallState = status.state ?? "—"

  let md = `## ${overallIcon} Kody Pipeline: \`${taskId}\`\n\n`
  md += `**Status:** ${overallState}\n\n`
  md += "| Stage | State |\n"
  md += "|-------|-------|\n"

  for (const stage of STAGES) {
    const stageData = status.stages?.[stage]
    const sState = stageData?.state ?? "—"
    const sIcon = iconForState(sState)
    md += `| ${padRight(stage, 11)} | ${sIcon} ${sState} |\n`
  }

  return md
}

/**
 * Reads status.json for the given task and writes summary to GITHUB_STEP_SUMMARY.
 */
export function runSummarize(): void {
  const taskId = process.env.TASK_ID
  if (!taskId) {
    console.error("TASK_ID env var is not set")
    process.exit(1)
  }

  const taskDir = process.env.TASK_DIR ?? ".kody/tasks"
  const statusPath = path.join(taskDir, taskId, "status.json")

  if (!fs.existsSync(statusPath)) {
    console.warn(`status.json not found at ${statusPath}, skipping summary`)
    return
  }

  let status: TaskStatus
  try {
    status = JSON.parse(fs.readFileSync(statusPath, "utf-8"))
  } catch (err) {
    console.error(`Failed to parse ${statusPath}:`, err)
    return
  }

  const summary = summarizeTask(taskId, status)

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    fs.appendFileSync(summaryPath, summary)
    console.log(`Summary written to ${summaryPath}`)
  } else {
    // Outside Actions: print to stdout
    process.stdout.write(summary)
  }
}
