import { execFileSync } from "child_process"

const API_TIMEOUT_MS = 30_000

export interface IssueComment {
  body: string
  author: string
  createdAt: string
}

export interface IssueData {
  number: number
  title: string
  body: string
  comments: IssueComment[]
}

function ghToken(): string | undefined {
  return process.env.GH_PAT?.trim() || process.env.GH_TOKEN
}

export function gh(args: string[], options?: { input?: string; cwd?: string }): string {
  const token = ghToken()
  const env: NodeJS.ProcessEnv = token ? { ...process.env, GH_TOKEN: token } : { ...process.env }
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: API_TIMEOUT_MS,
    cwd: options?.cwd,
    env,
    input: options?.input,
    stdio: options?.input ? ["pipe", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
  }).trim()
}

export function getIssue(issueNumber: number, cwd?: string): IssueData {
  const output = gh(
    ["issue", "view", String(issueNumber), "--json", "number,title,body,comments"],
    { cwd },
  )
  const parsed = JSON.parse(output)
  if (typeof parsed?.title !== "string") {
    throw new Error(`Issue #${issueNumber}: unexpected response shape`)
  }
  return {
    number: parsed.number ?? issueNumber,
    title: parsed.title,
    body: parsed.body ?? "",
    comments: (parsed.comments ?? []).map((c: { body: string; createdAt: string; author?: { login?: string } }) => ({
      body: c.body ?? "",
      author: c.author?.login ?? "unknown",
      createdAt: c.createdAt ?? "",
    })),
  }
}

export function postIssueComment(issueNumber: number, body: string, cwd?: string): void {
  try {
    gh(
      ["issue", "comment", String(issueNumber), "--body-file", "-"],
      { input: body, cwd },
    )
  } catch (err) {
    process.stderr.write(`[kody2] failed to post comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

export function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s
  return s.slice(0, maxBytes) + `… (+${s.length - maxBytes} chars)`
}

export interface PrData {
  number: number
  title: string
  body: string
  headRefName: string
  baseRefName: string
  state: string
}

export function getPr(prNumber: number, cwd?: string): PrData {
  const output = gh(
    ["pr", "view", String(prNumber), "--json", "number,title,body,headRefName,baseRefName,state"],
    { cwd },
  )
  const parsed = JSON.parse(output)
  if (typeof parsed?.title !== "string") {
    throw new Error(`PR #${prNumber}: unexpected response shape`)
  }
  return {
    number: parsed.number ?? prNumber,
    title: parsed.title,
    body: parsed.body ?? "",
    headRefName: String(parsed.headRefName ?? ""),
    baseRefName: String(parsed.baseRefName ?? ""),
    state: String(parsed.state ?? ""),
  }
}

export function getPrDiff(prNumber: number, cwd?: string): string {
  try {
    return gh(["pr", "diff", String(prNumber)], { cwd })
  } catch (err) {
    process.stderr.write(`[kody2] failed to fetch diff for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}\n`)
    return ""
  }
}

export interface PrReview {
  body: string
  state: string
  author: string
  submittedAt: string
}

export function getPrReviews(prNumber: number, cwd?: string): PrReview[] {
  try {
    const output = gh(
      ["pr", "view", String(prNumber), "--json", "reviews"],
      { cwd },
    )
    const parsed = JSON.parse(output)
    if (!Array.isArray(parsed?.reviews)) return []
    return parsed.reviews.map((r: { body?: string; state?: string; author?: { login?: string }; submittedAt?: string }) => ({
      body: r.body ?? "",
      state: r.state ?? "",
      author: r.author?.login ?? "unknown",
      submittedAt: r.submittedAt ?? "",
    }))
  } catch {
    return []
  }
}

/**
 * Return the most recent review-comment / review body that a human left on the PR.
 * Falls back to the PR body if no reviews exist.
 */
export function getPrLatestReviewBody(prNumber: number, cwd?: string): string {
  const reviews = getPrReviews(prNumber, cwd)
  const withBody = reviews.filter((r) => r.body.trim().length > 0)
  if (withBody.length > 0) {
    withBody.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""))
    return withBody[0]!.body
  }
  const pr = getPr(prNumber, cwd)
  return pr.body
}

export function postPrReviewComment(prNumber: number, body: string, cwd?: string): void {
  try {
    gh(["pr", "comment", String(prNumber), "--body-file", "-"], { input: body, cwd })
  } catch (err) {
    process.stderr.write(`[kody2] failed to post review comment on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
