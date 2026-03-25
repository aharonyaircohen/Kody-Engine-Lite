import { execFileSync } from "child_process"
import { logger } from "./logger.js"

const API_TIMEOUT_MS = 30_000

const LIFECYCLE_LABELS = ["planning", "building", "review", "done", "failed"]

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
  } catch (err) {
    logger.error(`  Failed to create PR: ${err}`)
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

export function closeIssue(
  issueNumber: number,
  reason: "completed" | "not planned" = "completed",
): void {
  try {
    gh(["issue", "close", String(issueNumber), "--reason", reason])
    logger.info(`  Issue #${issueNumber} closed: ${reason}`)
  } catch (err) {
    logger.warn(`  Failed to close issue: ${err}`)
  }
}
