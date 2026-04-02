/**
 * State stores: JSON file (local/test) and issue comment (CI persistence).
 */

import * as fs from "fs"
import * as path from "path"

import type { GitHubClient, StateStore } from "./types.js"

const STATE_MARKER = "<!-- KODY_WATCH_STATE:"

// ============================================================================
// JSON File State Store (local dev / testing)
// ============================================================================

export class JsonStateStore implements StateStore {
  private data: Record<string, unknown> = {}
  private filePath: string
  private dirty = false

  constructor(filePath: string) {
    this.filePath = filePath
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, "utf-8")
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === "object") {
          this.data = parsed as Record<string, unknown>
        }
      }
    } catch {
      this.data = {}
    }
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.data[key] = value
    this.dirty = true
  }

  save(): void {
    if (!this.dirty) return

    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const tempPath = `${this.filePath}.tmp`
    const json = JSON.stringify(this.data, null, 2)

    try {
      fs.writeFileSync(tempPath, json, "utf-8")
      fs.renameSync(tempPath, this.filePath)
      this.dirty = false
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
      }
      throw error
    }
  }
}

// ============================================================================
// Issue Comment State Store (CI persistence via digest issue)
// ============================================================================

/**
 * Persists state as a hidden HTML comment in the first comment of the digest issue.
 * Format: <!-- KODY_WATCH_STATE:{"system:cycleNumber":47,...} -->
 *
 * Uses only issue comment APIs — works with the default github.token, no PAT needed.
 */
export class IssueCommentStateStore implements StateStore {
  private data: Record<string, unknown> = {}
  private dirty = false
  private github: GitHubClient
  private digestIssue: number
  private commentId: number | null = null

  constructor(github: GitHubClient, digestIssue: number) {
    this.github = github
    this.digestIssue = digestIssue
    this.loadFromComment()
  }

  private loadFromComment(): void {
    try {
      const comments = this.github.getIssueComments(this.digestIssue)
      for (const comment of comments) {
        if (comment.body.includes(STATE_MARKER)) {
          this.commentId = comment.id
          const match = comment.body.match(/<!-- KODY_WATCH_STATE:(.*?) -->/)
          if (match) {
            const parsed = JSON.parse(match[1])
            if (parsed && typeof parsed === "object") {
              this.data = parsed as Record<string, unknown>
              return
            }
          }
        }
      }
    } catch {
      // Can't read comments — start fresh
    }
    this.data = {}
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.data[key] = value
    this.dirty = true
  }

  save(): void {
    if (!this.dirty) return

    const json = JSON.stringify(this.data)
    const cycle = this.data["system:cycleNumber"] ?? 0
    const body = `${STATE_MARKER}${json} -->\n\n_Kody Watch state — cycle #${cycle}, updated ${new Date().toISOString()}_`

    try {
      if (this.commentId) {
        this.github.updateComment(this.commentId, body)
      } else {
        this.github.postComment(this.digestIssue, body)
      }
      this.dirty = false
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[KodyWatch] Failed to save state: ${msg}`)
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create the appropriate state store based on environment.
 *
 * - In GitHub Actions with a digest issue: uses IssueCommentStateStore
 * - Locally: uses JsonStateStore at the given file path
 */
export function createStateStore(
  localFilePath: string,
  github?: GitHubClient,
  digestIssue?: number,
): StateStore {
  if (process.env.GITHUB_ACTIONS === "true" && github && digestIssue) {
    return new IssueCommentStateStore(github, digestIssue)
  }
  return new JsonStateStore(localFilePath)
}

export function createEmptyStateStore(): JsonStateStore {
  return new JsonStateStore("/dev/null")
}
