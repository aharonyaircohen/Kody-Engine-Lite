import { execFileSync } from "child_process"

const GH_TIMEOUT_MS = 30_000

function ghToken(): string | undefined {
  return process.env.GH_PAT?.trim() || process.env.GH_TOKEN
}

function gh(args: string[], cwd?: string): string {
  const token = ghToken()
  const env: NodeJS.ProcessEnv = token ? { ...process.env, GH_TOKEN: token } : { ...process.env }
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: GH_TIMEOUT_MS,
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

export interface FailedRun {
  id: string
  workflowName: string
  headBranch: string
  conclusion: string
  url: string
  createdAt: string
}

/**
 * Find the most recent failed workflow run on the PR's head branch.
 * Returns null if none found.
 */
export function getLatestFailedRunForPr(prNumber: number, cwd?: string): FailedRun | null {
  let headBranch: string
  try {
    const out = gh(["pr", "view", String(prNumber), "--json", "headRefName"], cwd)
    headBranch = JSON.parse(out).headRefName
  } catch {
    return null
  }
  if (!headBranch) return null

  try {
    const out = gh(
      [
        "run", "list",
        "--branch", headBranch,
        "--status", "failure",
        "--limit", "1",
        "--json", "databaseId,workflowName,headBranch,conclusion,url,createdAt",
      ],
      cwd,
    )
    const parsed = JSON.parse(out)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const r = parsed[0]
    return {
      id: String(r.databaseId ?? ""),
      workflowName: r.workflowName ?? "",
      headBranch: r.headBranch ?? headBranch,
      conclusion: r.conclusion ?? "failure",
      url: r.url ?? "",
      createdAt: r.createdAt ?? "",
    }
  } catch {
    return null
  }
}

/**
 * Fetch the failed-step log tail for a workflow run. Returns an empty
 * string on any error (caller decides how to handle).
 */
export function getFailedRunLogTail(runId: string, maxBytes: number, cwd?: string): string {
  try {
    const raw = gh(["run", "view", String(runId), "--log-failed"], cwd)
    if (raw.length <= maxBytes) return raw
    return raw.slice(-maxBytes)
  } catch {
    return ""
  }
}
