/**
 * State stores: JSON file (local/test) and GitHub Actions variable (CI persistence).
 */

import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import type { StateStore } from "./types.js"

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
// GitHub Actions Variable State Store (CI persistence)
// ============================================================================

const GH_VARIABLE_NAME = "KODY_WATCH_STATE"

export class GhVariableStateStore implements StateStore {
  private data: Record<string, unknown> = {}
  private dirty = false
  private repo: string

  constructor(repo: string) {
    this.repo = repo
    this.loadFromGh()
  }

  private loadFromGh(): void {
    try {
      const output = execFileSync(
        "gh",
        ["variable", "get", GH_VARIABLE_NAME, "--repo", this.repo],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, GH_TOKEN: process.env.GH_PAT || process.env.GH_TOKEN || "" },
        },
      ).trim()

      if (output) {
        const parsed = JSON.parse(output)
        if (parsed && typeof parsed === "object") {
          this.data = parsed as Record<string, unknown>
          return
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes("HTTP 404") && !msg.includes("variable not found")) {
        console.warn(`[KodyWatch] Failed to load state: ${msg} — starting fresh`)
      }
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

    try {
      execFileSync(
        "gh",
        ["variable", "set", GH_VARIABLE_NAME, "--repo", this.repo, "--body", json],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, GH_TOKEN: process.env.GH_PAT || process.env.GH_TOKEN || "" },
        },
      )
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

export function createStateStore(repo: string, localFilePath: string): StateStore {
  if (process.env.GITHUB_ACTIONS === "true") {
    return new GhVariableStateStore(repo)
  }
  return new JsonStateStore(localFilePath)
}

export function createEmptyStateStore(): JsonStateStore {
  return new JsonStateStore("/dev/null")
}
