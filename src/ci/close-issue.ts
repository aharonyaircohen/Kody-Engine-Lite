/**
 * Closes the GitHub issue linked to a PR merge.
 *
 * Usage: kody-engine ci-close-issue
 *
 * Env vars:
 *   GH_TOKEN       — GitHub token (or GITHUB_TOKEN)
 *   PR_NUMBER      — PR number that was merged
 *   PAYLOAD        — JSON-serialized GitHub workflow event (pull_request event)
 *
 * Logic:
 *   1. Extract issue number from branch name (e.g. "42-feature-name" → "42")
 *   2. Verify the issue exists and is open
 *   3. Close it with reason "completed"
 */

import { execSync } from "child_process"

interface WorkflowPayload {
  pull_request?: {
    head: { ref: string }
    number: number
  }
  repository?: {
    name: string
    owner: { login: string }
  }
}

function extractIssueNumber(branchName: string): string | null {
  const match = branchName.match(/^(\d+)-/)
  return match ? match[1] : null
}

function getGhToken(): string {
  return (
    process.env.GH_TOKEN ??
    process.env.GITHUB_TOKEN ??
    ""
  )
}

function ghExec(args: string[], token: string): string {
  return execSync(`gh ${args.join(" ")}`, {
    env: { ...process.env, GH_TOKEN: token },
    encoding: "utf-8",
  }).trim()
}

interface IssueState {
  state: string
  pullRequest: { number: number } | null
}

/**
 * Pure: checks whether an issue is open (not a PR).
 */
export async function closeLinkedIssue(
  token: string,
  payload: WorkflowPayload,
): Promise<void> {
  const pr = payload.pull_request
  if (!pr) return

  const issueNum = extractIssueNumber(pr.head.ref)
  if (!issueNum) return

  // Check if the issue exists and get its state
  let issueState: IssueState | null = null
  try {
    const output = ghExec(
      [
        "api",
        `repos/{owner}/{repo}/issues/${issueNum}`,
        "--jq", "{state:.state, pullRequest:.pull_request}",
        "--header", `Authorization: Bearer ${token}`,
      ],
      token,
    )
    issueState = JSON.parse(output)
  } catch {
    // Issue not found — nothing to close
    return
  }

  if (!issueState) return
  if (issueState.state === "closed") return
  if (issueState.pullRequest !== null) return // It's a PR, not an issue

  // Close the issue
  ghExec(
    [
      "api",
      `repos/{owner}/{repo}/issues/${issueNum}`,
      "--method", "PATCH",
      "--field", "state=closed",
      "--field", "state_reason=completed",
      "--header", `Authorization: Bearer ${token}`,
    ],
    token,
  )

  console.log(`Closed issue #${issueNum} after PR #${pr.number} was merged`)
}

/**
 * Reads env vars and runs closeLinkedIssue.
 */
export async function runCloseIssue(): Promise<void> {
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

  let payload: WorkflowPayload
  try {
    payload = JSON.parse(payloadRaw)
  } catch {
    console.error("Failed to parse PAYLOAD as JSON")
    process.exit(1)
  }

  await closeLinkedIssue(token, payload)
}
