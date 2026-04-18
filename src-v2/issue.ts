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
    process.stderr.write(`[kody-lean] failed to post comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

export function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s
  return s.slice(0, maxBytes) + `… (+${s.length - maxBytes} chars)`
}
