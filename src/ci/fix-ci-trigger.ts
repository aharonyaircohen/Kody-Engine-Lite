/**
 * Fix-CI auto-trigger logic for workflow_run events.
 *
 * Usage: kody-engine fix-ci-trigger
 *
 * Env vars:
 *   GH_TOKEN  — GitHub token
 *   PAYLOAD   — JSON-serialized workflow_run event
 *
 * Logic:
 *   1. List recent comments on the PR (last 30)
 *   2. Skip if @kody fix-ci was already commented in last 24h (loop guard)
 *   3. Check if last commit was from a bot → skip if so (loop guard)
 *   4. Create a tracking issue for the CI failure
 *   5. Post @kody fix-ci comment on the PR
 */

import { execFileSync } from "child_process"

const API_TIMEOUT_MS = 30_000
const LOOP_GUARD_HOURS = 24

interface WorkflowRunEvent {
  workflow_run: {
    id: number
    html_url: string
    conclusion: string
    event: string
    pull_requests: Array<{ number: number }>
  }
}

interface Comment {
  body: string
  created_at: string
  author: { login: string }
}

interface Commit {
  commit: {
    author: { name: string }
  }
}

function getGhToken(): string {
  return process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ""
}

function gh(args: string[], token: string): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: API_TIMEOUT_MS,
    env: { ...process.env, GH_TOKEN: token },
  }).trim()
}

function ghNoToken(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: API_TIMEOUT_MS,
  }).trim()
}

/**
 * Returns comments on a PR from the last N hours.
 */
function getRecentComments(prNumber: number, hours: number): Comment[] {
  const results: Comment[] = []
  try {
    const output = ghNoToken([
      "api",
      `repos/{owner}/{repo}/issues/${prNumber}/comments`,
      "--jq", `.[] | {body: .body, created_at: .created_at, author: .user}`,
      "--limit", "30",
    ])
    if (output) {
      for (const line of output.split("\n")) {
        if (!line.trim()) continue
        try {
          results.push(JSON.parse(line))
        } catch { /* skip malformed lines */ }
      }
    }
  } catch { /* no comments */ }
  return results
}

function isRecent(createdAt: string, hours: number): boolean {
  const created = new Date(createdAt).getTime()
  const cutoff = Date.now() - hours * 60 * 60 * 1000
  return created > cutoff
}

/**
 * Returns the author name of the last commit on a PR.
 */
function getLastCommitAuthor(prNumber: number): string | null {
  try {
    const output = ghNoToken([
      "api",
      `repos/{owner}/{repo}/pulls/${prNumber}/commits`,
      "--jq", ".[-1].commit.author.name",
      "--limit", "1",
    ])
    return output || null
  } catch {
    return null
  }
}

/**
 * Checks whether fix-ci should run based on loop guards.
 */
export function checkLoopGuard(prNumber: number): { allowed: boolean; reason: string } {
  const comments = getRecentComments(prNumber, LOOP_GUARD_HOURS)
  const recentFixCi = comments.filter((c) =>
    c.body?.includes("@kody fix-ci") && isRecent(c.created_at, LOOP_GUARD_HOURS),
  )
  if (recentFixCi.length >= 1) {
    return { allowed: false, reason: "Loop guard: @kody fix-ci already commented in last 24h" }
  }

  const lastAuthor = getLastCommitAuthor(prNumber)
  if (lastAuthor === "github-actions[bot]" || lastAuthor === "kody[bot]") {
    return { allowed: false, reason: "Loop guard: last commit from bot" }
  }

  return { allowed: true, reason: "" }
}

/**
 * Creates a tracking issue for the CI failure.
 */
export function createTrackingIssue(
  token: string,
  prNumber: number,
  runId: number,
  runUrl: string,
): void {
  const title = `CI failing on PR #${prNumber}`
  const body = `CI failed on PR #${prNumber}.\n\n[View CI logs](${runUrl})\nRun ID: ${runId}\n\n@kody fix-ci`

  gh(["issue", "create", "--title", title, "--body", body, "--label", "ci", "--label", "automated"], token)
}

/**
 * Posts a @kody fix-ci comment on the PR.
 */
export function postFixCiComment(
  token: string,
  prNumber: number,
  runUrl: string,
  runId: number,
): void {
  const body = `@kody fix-ci\nCI failed: [View logs](${runUrl})\nRun ID: ${runId}`
  gh(["issue", "comment", prNumber.toString(), "--body", body], token)
}

/**
 * Runs the full fix-ci-trigger logic.
 */
export async function runFixCiTrigger(): Promise<void> {
  const token = getGhToken()
  if (!token) {
    console.error("GH_TOKEN / GITHUB_TOKEN env var is not set")
    process.exit(1)
  }

  const payloadRaw = process.env.PAYLOAD
  if (!payloadRaw) {
    console.error("PAYLOAD env var is not set")
    process.exit(1)
  }

  let event: WorkflowRunEvent
  try {
    event = JSON.parse(payloadRaw)
  } catch {
    console.error("Failed to parse PAYLOAD as JSON")
    process.exit(1)
  }

  const { workflow_run: run } = event
  const pr = run.pull_requests?.[0]
  if (!pr) {
    console.log("No PRs associated with this workflow run, skipping")
    return
  }

  const prNumber = pr.number
  const runId = run.id
  const runUrl = run.html_url

  // Loop guard checks
  const guard = checkLoopGuard(prNumber)
  if (!guard.allowed) {
    console.log(guard.reason)
    return
  }

  // Create tracking issue
  try {
    createTrackingIssue(token, prNumber, runId, runUrl)
    console.log(`Created tracking issue for PR #${prNumber}`)
  } catch (err) {
    console.error(`Failed to create tracking issue: ${err}`)
  }

  // Post fix-ci comment
  try {
    postFixCiComment(token, prNumber, runUrl, runId)
    console.log(`Posted @kody fix-ci comment on PR #${prNumber}`)
  } catch (err) {
    console.error(`Failed to post comment: ${err}`)
  }
}
