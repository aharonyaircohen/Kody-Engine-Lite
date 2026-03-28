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
): void {
  const flag = event === "approve" ? "--approve" : "--request-changes"
  try {
    gh(
      ["pr", "review", String(prNumber), flag, "--body-file", "-"],
      { input: body },
    )
    logger.info(`  PR review submitted on #${prNumber}: ${event}`)
  } catch (err) {
    logger.warn(`  Failed to submit PR review: ${err}`)
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
