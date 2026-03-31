import { execFileSync } from "child_process"
import { logger } from "./logger.js"

const API_TIMEOUT_MS = 30_000

const LIFECYCLE_LABELS = ["planning", "building", "review", "done", "failed", "waiting", "low", "medium", "high"]

let _ghCwd: string | undefined

export function setGhCwd(cwd: string): void {
  _ghCwd = cwd
}

function ghToken(): string | undefined {
  return process.env.GH_PAT?.trim() || process.env.GH_TOKEN
}

function gh(args: string[], options?: { input?: string }): string {
  const token = ghToken()
  const env = token
    ? { ...process.env, GH_TOKEN: token }
    : { ...process.env }

  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: API_TIMEOUT_MS,
    cwd: _ghCwd,
    env,
    input: options?.input,
    stdio: options?.input ? ["pipe", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
  }).trim()
}

export function getIssue(
  issueNumber: number,
): { body: string; title: string } | null {
  try {
    const output = gh([
      "issue", "view", String(issueNumber),
      "--json", "body,title",
    ])
    return JSON.parse(output)
  } catch (err) {
    logger.error(`  Failed to get issue #${issueNumber}: ${err}`)
    return null
  }
}

export function getIssueLabels(issueNumber: number): string[] {
  try {
    const output = gh(["issue", "view", String(issueNumber), "--json", "labels", "--jq", ".labels[].name"])
    return output.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

export function setLabel(issueNumber: number, label: string): void {
  try {
    gh(["issue", "edit", String(issueNumber), "--add-label", label])
    logger.info(`  Label added: ${label}`)
  } catch (err) {
    logger.warn(`  Failed to set label ${label}: ${err}`)
  }
}

export function removeLabel(issueNumber: number, label: string): void {
  try {
    gh(["issue", "edit", String(issueNumber), "--remove-label", label])
  } catch {
    // Label may not exist — ignore
  }
}

export function postComment(issueNumber: number, body: string): void {
  try {
    gh(
      ["issue", "comment", String(issueNumber), "--body-file", "-"],
      { input: body },
    )
    logger.info(`  Comment posted on #${issueNumber}`)
  } catch (err) {
    logger.warn(`  Failed to post comment: ${err}`)
  }
}

export function getPRForBranch(
  branch: string,
): { number: number; url: string } | null {
  try {
    const output = gh([
      "pr", "view", branch,
      "--json", "number,url",
    ])
    const data = JSON.parse(output)
    return { number: data.number, url: data.url }
  } catch {
    return null
  }
}

export function updatePR(
  prNumber: number,
  body: string,
): void {
  try {
    gh(
      ["pr", "edit", String(prNumber), "--body-file", "-"],
      { input: body },
    )
    logger.info(`  PR #${prNumber} body updated`)
  } catch (err) {
    logger.warn(`  Failed to update PR #${prNumber}: ${err}`)
  }
}

export function createPR(
  head: string,
  base: string,
  title: string,
  body: string,
): { number: number; url: string } | null {
  try {
    const output = gh(
      [
        "pr", "create",
        "--head", head,
        "--base", base,
        "--title", title,
        "--body-file", "-",
      ],
      { input: body },
    )
    const url = output.trim()
    const match = url.match(/\/pull\/(\d+)$/)
    const number = match ? parseInt(match[1], 10) : 0
    logger.info(`  PR created: ${url}`)
    return { number, url }
  } catch (err: any) {
    const stderr = err?.stderr?.toString().trim()
    const reason = stderr || (err instanceof Error ? err.message : String(err))
    logger.error(`  Failed to create PR: ${reason}`)
    return null
  }
}

export function setLifecycleLabel(
  issueNumber: number,
  phase: string,
): void {
  if (!LIFECYCLE_LABELS.includes(phase)) {
    logger.warn(`  Invalid lifecycle phase: ${phase}`)
    return
  }

  // Remove all other lifecycle labels
  const othersToRemove = LIFECYCLE_LABELS
    .filter((l) => l !== phase)
    .map((l) => `kody:${l}`)
    .join(",")

  if (othersToRemove) {
    try {
      gh(["issue", "edit", String(issueNumber), "--remove-label", othersToRemove])
    } catch {
      // Labels may not exist — ignore
    }
  }

  // Add new label
  setLabel(issueNumber, `kody:${phase}`)
}

export function getPRsForIssue(
  issueNumber: number,
): { number: number; title: string; url: string; headBranch: string }[] {
  try {
    const output = gh([
      "pr", "list",
      "--search", `${issueNumber} in:body`,
      "--json", "number,title,url,headRefName",
      "--state", "open",
    ])
    const prs = JSON.parse(output) as { number: number; title: string; url: string; headRefName: string }[]
    // Also match PRs whose branch starts with the issue number (e.g. 42-feature-name)
    const branchPrs = (() => {
      try {
        const branchOutput = gh([
          "pr", "list",
          "--json", "number,title,url,headRefName",
          "--state", "open",
        ])
        return (JSON.parse(branchOutput) as { number: number; title: string; url: string; headRefName: string }[])
          .filter((pr) => pr.headRefName.startsWith(`${issueNumber}-`))
      } catch { return [] }
    })()

    // Merge and dedupe by PR number
    const seen = new Set<number>()
    const merged: { number: number; title: string; url: string; headBranch: string }[] = []
    for (const pr of [...prs, ...branchPrs]) {
      if (!seen.has(pr.number)) {
        seen.add(pr.number)
        merged.push({ number: pr.number, title: pr.title, url: pr.url, headBranch: pr.headRefName })
      }
    }
    return merged
  } catch (err) {
    logger.error(`  Failed to get PRs for issue #${issueNumber}: ${err}`)
    return []
  }
}

export function getPRDetails(
  prNumber: number,
): { title: string; body: string; headBranch: string; baseBranch: string } | null {
  try {
    const output = gh([
      "pr", "view", String(prNumber),
      "--json", "title,body,headRefName,baseRefName",
    ])
    const data = JSON.parse(output)
    return { title: data.title, body: data.body, headBranch: data.headRefName, baseBranch: data.baseRefName }
  } catch (err) {
    logger.error(`  Failed to get PR #${prNumber}: ${err}`)
    return null
  }
}

export function postPRComment(prNumber: number, body: string): void {
  try {
    gh(
      ["pr", "comment", String(prNumber), "--body-file", "-"],
      { input: body },
    )
    logger.info(`  Comment posted on PR #${prNumber}`)
  } catch (err) {
    logger.warn(`  Failed to post PR comment: ${err}`)
  }
}

export function submitPRReview(
  prNumber: number,
  body: string,
  event: "approve" | "request-changes",
): boolean {
  const flag = event === "approve" ? "--approve" : "--request-changes"
  try {
    gh(
      ["pr", "review", String(prNumber), flag, "--body-file", "-"],
      { input: body },
    )
    logger.info(`  PR review submitted on #${prNumber}: ${event}`)
    return true
  } catch (err) {
    logger.warn(`  Failed to submit PR review: ${err}`)
    return false
  }
}

export function getCIFailureLogs(
  runId: string | number,
  maxLength: number = 8000,
): string | null {
  try {
    const logsOutput = gh([
      "run", "view", String(runId),
      "--log-failed",
    ])
    if (!logsOutput) return null
    const truncated = logsOutput.slice(-maxLength)
    const prefix = logsOutput.length > maxLength ? "...(earlier output truncated)\n" : ""
    return `${prefix}${truncated}`
  } catch (err) {
    logger.warn(`  Failed to get CI failure logs for run ${runId}: ${err}`)
    return null
  }
}

export function getLatestFailedRunForBranch(branch: string): string | null {
  try {
    const output = gh([
      "run", "list",
      "--branch", branch,
      "--status", "failure",
      "--limit", "1",
      "--json", "databaseId",
      "--jq", ".[0].databaseId",
    ])
    return output.trim() || null
  } catch (err) {
    logger.warn(`  Failed to get latest failed run for branch ${branch}: ${err}`)
    return null
  }
}

export function getLatestKodyReviewComment(prNumber: number): string | null {
  try {
    const output = gh([
      "api",
      `repos/{owner}/{repo}/issues/${prNumber}/comments`,
      "--jq", "[.[] | select(.body | test(\"Kody Review\"))] | last | .body",
    ])
    return output.trim() || null
  } catch (err) {
    logger.warn(`  Failed to get review comments for PR #${prNumber}: ${err}`)
    return null
  }
}

/**
 * Fetch human PR feedback (issue comments + review comments) since the last
 * Kody action on the PR. This scopes context to the current fix cycle,
 * avoiding confusion from already-addressed feedback.
 *
 * Returns null if no human comments are found.
 */
export function getPRFeedbackSinceLastKodyAction(prNumber: number): string | null {
  try {
    // Fetch issue comments (general PR comments)
    const issueCommentsRaw = gh([
      "api",
      `repos/{owner}/{repo}/issues/${prNumber}/comments`,
      "--jq", "[.[] | {body, created_at, user_login: .user.login, user_type: .user.type}]",
    ])
    const issueComments: PRComment[] = issueCommentsRaw ? JSON.parse(issueCommentsRaw) : []

    // Fetch PR review comments (inline code comments)
    const reviewCommentsRaw = gh([
      "api",
      `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
      "--jq", "[.[] | {body, created_at, user_login: .user.login, user_type: .user.type, path, line}]",
    ])
    const reviewComments: PRReviewComment[] = reviewCommentsRaw ? JSON.parse(reviewCommentsRaw) : []

    // Find the last Kody action timestamp
    const kodyTimestamp = findLastKodyActionTimestamp(issueComments)

    // Filter to human comments after the last Kody action
    const humanIssueComments = issueComments.filter(
      (c) => !isKodyComment(c) && (!kodyTimestamp || c.created_at > kodyTimestamp),
    )
    const humanReviewComments = reviewComments.filter(
      (c) => !isKodyComment(c) && (!kodyTimestamp || c.created_at > kodyTimestamp),
    )

    if (humanIssueComments.length === 0 && humanReviewComments.length === 0) {
      return null
    }

    // Format into readable context
    const parts: string[] = []

    if (humanIssueComments.length > 0) {
      parts.push("### PR Comments")
      for (const c of humanIssueComments) {
        parts.push(`**@${c.user_login}:**\n${c.body}`)
      }
    }

    if (humanReviewComments.length > 0) {
      parts.push("### Code Review Comments")
      for (const c of humanReviewComments) {
        const location = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ""}\`` : ""
        parts.push(`**@${c.user_login}** ${location}:\n${c.body}`)
      }
    }

    return parts.join("\n\n")
  } catch (err) {
    logger.warn(`  Failed to get PR feedback for #${prNumber}: ${err}`)
    return null
  }
}

interface PRComment {
  body: string
  created_at: string
  user_login: string
  user_type: string
}

interface PRReviewComment extends PRComment {
  path?: string
  line?: number
}

const KODY_MARKERS = [
  "Kody Review",
  "🤖 Generated by Kody",
  "Kody pipeline started",
  "Fix pushed to PR",
  "PR created:",
  "Pipeline failed at",
  "Pipeline already running",
  "already completed",
]

function isKodyComment(comment: PRComment): boolean {
  if (comment.user_type === "Bot") return true
  return KODY_MARKERS.some((marker) => comment.body.includes(marker))
}

function findLastKodyActionTimestamp(comments: PRComment[]): string | null {
  const kodyComments = comments.filter(isKodyComment)
  if (kodyComments.length === 0) return null
  // Comments are returned chronologically, take the last one
  return kodyComments[kodyComments.length - 1].created_at
}
