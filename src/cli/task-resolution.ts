import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { getIssueComments } from "../github-api.js"

export function findLatestTaskForIssue(issueNumber: number, projectDir: string): string | null {
  const tasksDir = path.join(projectDir, ".kody", "tasks")
  if (!fs.existsSync(tasksDir)) return null

  // Only consider directories (not files)
  const allDirs = fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()

  // Direct match: tasks starting with issue number
  const prefix = `${issueNumber}-`
  const direct = allDirs.find((d) => d.startsWith(prefix))
  if (direct) return direct

  // Fallback for PR comments: extract issue number from current git branch
  // Branch format: <issueNum>--<slug> (e.g., 1031--security-8x-route)
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf-8", cwd: projectDir, timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const branchIssueMatch = branch.match(/^(\d+)-/)
    if (branchIssueMatch) {
      const branchIssueNum = branchIssueMatch[1]
      const branchPrefix = `${branchIssueNum}-`
      const fromBranch = allDirs.find((d) => d.startsWith(branchPrefix))
      if (fromBranch) return fromBranch
    }
  } catch { /* ignore */ }

  return null
}

export function generateTaskId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Scan issue comments for "pipeline started: `<task-id>`" pattern
 * and return the most recent task-id match.
 */
export function resolveTaskIdFromComments(issueNumber: number): string | null {
  try {
    const comments = getIssueComments(issueNumber)
    const pattern = /pipeline started: `([^`]+)`/

    let latestTaskId: string | null = null
    for (const comment of comments) {
      const match = comment.body.match(pattern)
      if (match) {
        latestTaskId = match[1]
      }
    }

    return latestTaskId
  } catch {
    return null
  }
}

/**
 * Auto-resolve a task-id for rerun/status commands when no explicit --task-id
 * is provided. Prefers .kody/tasks/ directory scan, falls back to issue comments.
 */
export function resolveTaskIdForCommand(issueNumber: number, projectDir: string): string | null {
  // First: scan .kody/tasks/ for the latest task matching this issue
  const fromTasks = findLatestTaskForIssue(issueNumber, projectDir)
  if (fromTasks) return fromTasks

  // Second: scan issue comments for "pipeline started: `<task-id>`"
  const fromComments = resolveTaskIdFromComments(issueNumber)
  if (fromComments) return fromComments

  return null
}
