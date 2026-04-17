/**
 * Target-repo gitignore management for transient graph artifacts.
 *
 * The graph store creates three kinds of files that must NEVER be committed:
 *   - `.graph-lock` and `.graph-lock.lock/` — proper-lockfile sentinels
 *   - `*.bak` — rolling backups from atomicWrite
 *   - `*.tmp.*` — in-flight atomic-write tmp files
 *
 * Called from init (setup) and from the pipeline (pre-flight repair so old
 * repos that already committed these files get cleaned up).
 */

import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

export const GRAPH_GITIGNORE_MARKER = "# kody graph transient artifacts (do not commit)"

export const GRAPH_GITIGNORE_ENTRIES = [
  ".kody/graph/.graph-lock",
  ".kody/graph/.graph-lock.lock/",
  ".kody/graph/*.bak",
  ".kody/graph/*.tmp.*",
  ".kody/graph/episodes/*.bak",
  ".kody/graph/episodes/*.tmp.*",
] as const

/**
 * Ensure the target repo's `.gitignore` excludes the graph transient
 * artifacts. Idempotent — safe to run on every pipeline start.
 *
 * Returns true if the .gitignore was modified.
 */
export function ensureGraphGitignore(projectDir: string): boolean {
  const gitignorePath = path.join(projectDir, ".gitignore")
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf-8")
    : ""

  // Which required entries are missing?
  const missing = GRAPH_GITIGNORE_ENTRIES.filter((e) => !matchesIgnoreLine(existing, e))
  if (missing.length === 0) return false

  const block = [
    existing.endsWith("\n") || existing.length === 0 ? "" : "\n",
    existing.length === 0 ? "" : "\n",
    `${GRAPH_GITIGNORE_MARKER}\n`,
    ...missing.map((e) => `${e}\n`),
  ].join("")

  fs.writeFileSync(gitignorePath, existing + block)
  return true
}

/**
 * Check whether a .gitignore line exactly (ignoring leading `!` negation
 * and surrounding whitespace) matches `entry`.
 */
function matchesIgnoreLine(content: string, entry: string): boolean {
  for (const raw of content.split("\n")) {
    const line = raw.trim().replace(/^!/, "")
    if (line === entry) return true
  }
  return false
}

/**
 * If any of the graph transient artifacts is currently tracked by git,
 * untrack it (`git rm --cached`) so the next commit doesn't re-include it.
 * Files are not removed from disk. Safe to run even in a non-git directory.
 *
 * Returns the list of paths that were untracked.
 */
export function untrackGraphArtifacts(projectDir: string): string[] {
  const candidates = [
    ".kody/graph/.graph-lock",
    ".kody/graph/nodes.json.bak",
    ".kody/graph/edges.json.bak",
  ]

  const untracked: string[] = []
  for (const rel of candidates) {
    const abs = path.join(projectDir, rel)
    if (!fs.existsSync(abs)) continue
    if (!isTracked(projectDir, rel)) continue
    try {
      execFileSync("git", ["rm", "--cached", "--", rel], {
        cwd: projectDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5_000,
      })
      untracked.push(rel)
    } catch {
      // File not tracked or git failure — non-fatal
    }
  }
  return untracked
}

function isTracked(projectDir: string, relPath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
      cwd: projectDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    })
    return true
  } catch {
    return false
  }
}
