/**
 * Thin wrapper around gh CLI, conforming to GitHubClient interface.
 */

import { execFileSync } from "child_process"

import type { GitHubClient, IssueComment, IssueInfo } from "../core/types.js"

export function createGitHubClient(repo: string, token: string): GitHubClient {
  const gh = (args: string[], input?: string): string => {
    try {
      return execFileSync("gh", args, {
        input,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, GH_TOKEN: token },
      }).trim()
    } catch {
      return ""
    }
  }

  return {
    postComment(issueNumber: number, body: string): void {
      gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"], body)
    },

    getIssue(issueNumber: number): { body: string | null; title: string | null } {
      const output = gh([
        "api",
        `repos/${repo}/issues/${issueNumber}`,
        "--jq",
        "{body: .body, title: .title}",
      ])
      if (!output) return { body: null, title: null }
      try {
        return JSON.parse(output)
      } catch {
        return { body: null, title: null }
      }
    },

    getIssueComments(issueNumber: number): IssueComment[] {
      const output = gh([
        "api",
        `repos/${repo}/issues/${issueNumber}/comments`,
        "--paginate",
        "--jq",
        "[.[] | {id: .id, body: .body}]",
      ])
      if (!output) return []
      return output
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return JSON.parse(line) as IssueComment[]
          } catch {
            return []
          }
        })
    },

    updateComment(commentId: number, body: string): void {
      gh([
        "api",
        `repos/${repo}/issues/comments/${commentId}`,
        "--method", "PATCH",
        "--field", `body=${body}`,
      ])
    },

    getOpenIssues(labels?: string[]): IssueInfo[] {
      let query = `repos/${repo}/issues`
      if (labels && labels.length > 0) {
        query += `?labels=${labels.join(",")}`
      }

      const output = gh([
        "api",
        query,
        "--paginate",
        "--jq",
        '[.[] | select(.state == "open") | select(.pull_request == null) | {number: .number, title: .title, labels: [.labels[].name], updatedAt: .updated_at}]',
      ])

      if (!output) return []

      return output
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return JSON.parse(line) as IssueInfo[]
          } catch {
            return []
          }
        })
    },

    createIssue(title: string, body: string, labels: string[]): number | null {
      const args = ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"]
      const output = gh(args, body)
      if (!output) return null

      const match = output.match(/\/issues\/(\d+)/)
      const issueNumber = match ? parseInt(match[1], 10) : null

      if (issueNumber && labels.length > 0) {
        gh(["issue", "edit", String(issueNumber), "--repo", repo, "--add-label", labels.join(",")])
      }

      return issueNumber
    },

    searchIssues(query: string): IssueInfo[] {
      const output = gh([
        "api",
        `search/issues?q=${encodeURIComponent(query + ` repo:${repo}`)}&per_page=30`,
        "--jq",
        "[.items[] | {number: .number, title: .title, labels: [.labels[].name], updatedAt: .updated_at}]",
      ])

      if (!output) return []
      try {
        return JSON.parse(output) as IssueInfo[]
      } catch {
        return []
      }
    },

    getIssueLabels(issueNumber: number): string[] {
      const output = gh([
        "api",
        `repos/${repo}/issues/${issueNumber}`,
        "--jq",
        "[.labels[].name]",
      ])
      if (!output) return []
      try {
        return JSON.parse(output) as string[]
      } catch {
        return []
      }
    },
  }
}
