import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { getIssueComments, getPRDetails } from "../github-api.js"

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
  // Branch format: <issueNum>-<slug> (e.g., 1031-security-8x-route)
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
 * Scan .kody/tasks/ for a directory that contains a taskify.marker for this
 * issue number. This is used to resume a paused standalone taskify run even
 * when the task-id doesn't start with the issue number (e.g. "taskify-258-...").
 */
export function findPausedTaskifyForIssue(issueNumber: number, projectDir: string): string | null {
  const tasksDir = path.join(projectDir, ".kody", "tasks")
  if (!fs.existsSync(tasksDir)) return null

  const allDirs = fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()

  for (const dir of allDirs) {
    const markerPath = path.join(tasksDir, dir, "taskify.marker")
    if (!fs.existsSync(markerPath)) continue
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"))
      if (marker.issueNumber === issueNumber) return dir
    } catch { /* ignore malformed markers */ }
  }

  return null
}

/**
 * Resolve the original issue number from a PR.
 * Parses PR body for "Closes #N", "Fixes #N", "Resolves #N",
 * or extracts from branch name pattern "{issueNum}-{slug}".
 */
export function resolveIssueFromPR(prNumber: number): number | undefined {
  try {
    const details = getPRDetails(prNumber)
    if (!details) return undefined

    // Parse PR body for closing keywords
    const body = details.body ?? ""
    const closingPattern = /(?:closes|fixes|resolves)\s+#(\d+)/i
    const match = body.match(closingPattern)
    if (match) return parseInt(match[1], 10)

    // Extract from branch name: {issueNum}-{slug}
    const branchMatch = details.headBranch?.match(/^(\d+)-/)
    if (branchMatch) return parseInt(branchMatch[1], 10)

    return undefined
  } catch {
    return undefined
  }
}

/**
 * Auto-resolve a task-id for rerun/status commands when no explicit --task-id
 * is provided.
 *
 * @param preferGitHub  When true (CI context for rerun/approve), checks the GitHub
 *                      API comment first — the local .kody/tasks/ may not contain
 *                      the task directory if the pipeline ran on a PR branch.
 */
export function resolveTaskIdForCommand(
  issueNumber: number,
  projectDir: string,
  preferGitHub = false,
): string | null {
  if (preferGitHub) {
    // CI / approve context: GitHub comment is the authoritative source.
    // The pipeline-start comment is guaranteed to exist and references the taskId.
    const fromComments = resolveTaskIdFromComments(issueNumber)
    if (fromComments) return fromComments

    // Fall back to local scan (e.g. main branch has the task from a prior run)
    const fromTaskify = findPausedTaskifyForIssue(issueNumber, projectDir)
    if (fromTaskify) return fromTaskify
    const fromTasks = findLatestTaskForIssue(issueNumber, projectDir)
    if (fromTasks) return fromTasks

    return null
  }

  // Local run: prefer local .kody/tasks/ scan, then GitHub comment
  const fromTaskify = findPausedTaskifyForIssue(issueNumber, projectDir)
  if (fromTaskify) return fromTaskify

  const fromTasks = findLatestTaskForIssue(issueNumber, projectDir)
  if (fromTasks) return fromTasks

  const fromComments = resolveTaskIdFromComments(issueNumber)
  if (fromComments) return fromComments

  return null
}
