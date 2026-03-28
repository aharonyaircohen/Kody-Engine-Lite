import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

export function findLatestTaskForIssue(issueNumber: number, projectDir: string): string | null {
  const tasksDir = path.join(projectDir, ".kody", "tasks")
  if (!fs.existsSync(tasksDir)) return null

  // Only consider directories (not files)
  const allDirs = fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()

  // Direct match: tasks starting with issue number
  const prefix = `${issueNumber}-`
  const direct = allDirs.find((d) => d.startsWith(prefix))
  if (direct) return direct

  // Fallback for PR comments: extract issue number from current git branch
  // Branch format: <issueNum>--<slug> (e.g., 1031--security-8x-route)
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf-8", cwd: projectDir, timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const branchIssueMatch = branch.match(/^(\d+)-/)
    if (branchIssueMatch) {
      const branchIssueNum = branchIssueMatch[1]
      const branchPrefix = `${branchIssueNum}-`
      const fromBranch = allDirs.find((d) => d.startsWith(branchPrefix))
      if (fromBranch) return fromBranch
    }
  } catch { /* ignore */ }

  return null
}

export function generateTaskId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
