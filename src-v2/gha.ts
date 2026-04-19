/**
 * Thin helpers that read the GitHub Actions env and do GHA-specific side
 * effects (react to a trigger comment, build a run URL). Kept in one place
 * so flow scripts stay generic.
 */

import * as fs from "fs"
import { execFileSync } from "child_process"

/** Link to the currently-running workflow run, or "" when not in Actions. */
export function getRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL
  const repo = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  if (!server || !repo || !runId) return ""
  return `${server}/${repo}/actions/runs/${runId}`
}

/**
 * When kody2 was triggered by an `issue_comment` event, read the comment id
 * from the GHA event payload and POST a 👀 reaction on it. Silent no-op when
 * not running in Actions or when the event isn't an issue_comment.
 */
export function reactToTriggerComment(cwd?: string): void {
  if (process.env.GITHUB_EVENT_NAME !== "issue_comment") return
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return

  let event: { comment?: { id?: number } } | null = null
  try { event = JSON.parse(fs.readFileSync(eventPath, "utf-8")) } catch { return }
  const commentId = event?.comment?.id
  const repo = process.env.GITHUB_REPOSITORY
  if (!commentId || !repo) return

  const token = process.env.KODY_TOKEN?.trim() || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  try {
    execFileSync(
      "gh",
      [
        "api",
        "-X", "POST",
        "-H", "Accept: application/vnd.github+json",
        `/repos/${repo}/issues/comments/${commentId}/reactions`,
        "-f", "content=eyes",
      ],
      {
        cwd,
        env: { ...process.env, GH_TOKEN: token ?? process.env.GH_TOKEN ?? "" },
        stdio: "pipe",
        timeout: 15_000,
      },
    )
  } catch { /* best effort — never block the run on reaction failure */ }
}
