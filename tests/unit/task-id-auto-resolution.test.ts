import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

/**
 * Enhancement #2: Task-id auto-resolution for rerun and status commands.
 *
 * When `@kody rerun` or `@kody status` is invoked without --task-id but with
 * --issue-number, the engine should auto-resolve the task-id by:
 *   1. Scanning `.kody/tasks/` for the latest task matching the issue
 *   2. Falling back to scanning issue comments for "pipeline started: `<task-id>`"
 *   3. Returning a clear error if no task is found
 */

// --- Unit tests for resolveTaskIdFromComments ---

vi.mock("../../src/github-api.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    getIssueComments: vi.fn(() => []),
  }
})

import { getIssueComments } from "../../src/github-api.js"
import { resolveTaskIdFromComments } from "../../src/cli/task-resolution.js"

describe("resolveTaskIdFromComments", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("extracts task-id from 'pipeline started' comment", () => {
    vi.mocked(getIssueComments).mockReturnValue([
      { body: "🚀 Kody pipeline started: `42-260327-100000`\n\nTo rerun: `@kody rerun 42-260327-100000 --from <stage>`", created_at: "2026-03-27T10:00:00Z" },
    ])

    const result = resolveTaskIdFromComments(42)
    expect(result).toBe("42-260327-100000")
  })

  it("returns the most recent match when multiple pipeline comments exist", () => {
    vi.mocked(getIssueComments).mockReturnValue([
      { body: "🚀 Kody pipeline started: `42-260326-090000`", created_at: "2026-03-26T09:00:00Z" },
      { body: "🚀 Kody pipeline started: `42-260327-100000`", created_at: "2026-03-27T10:00:00Z" },
    ])

    const result = resolveTaskIdFromComments(42)
    expect(result).toBe("42-260327-100000")
  })

  it("returns null when no pipeline comments exist", () => {
    vi.mocked(getIssueComments).mockReturnValue([
      { body: "Some unrelated comment", created_at: "2026-03-27T10:00:00Z" },
    ])

    const result = resolveTaskIdFromComments(42)
    expect(result).toBeNull()
  })

  it("returns null when getIssueComments returns empty array", () => {
    vi.mocked(getIssueComments).mockReturnValue([])

    const result = resolveTaskIdFromComments(42)
    expect(result).toBeNull()
  })

  it("returns null when gh API throws", () => {
    vi.mocked(getIssueComments).mockImplementation(() => {
      throw new Error("gh not available")
    })

    const result = resolveTaskIdFromComments(42)
    expect(result).toBeNull()
  })
})

// --- Unit tests for resolveTaskIdForCommand ---

import { resolveTaskIdForCommand } from "../../src/cli/task-resolution.js"

describe("resolveTaskIdForCommand", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-resolve-"))
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks"), { recursive: true })
    vi.mocked(getIssueComments).mockReturnValue([])
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("rerun with no task-id + issue-number resolves latest task from .kody/tasks/", () => {
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks", "42-260327-100000"))

    const result = resolveTaskIdForCommand(42, tmpDir)
    expect(result).toBe("42-260327-100000")
  })

  it("status with no task-id + issue-number resolves latest task from .kody/tasks/", () => {
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks", "42-260327-100000"))

    // Same function used by both rerun and status
    const result = resolveTaskIdForCommand(42, tmpDir)
    expect(result).toBe("42-260327-100000")
  })

  it("prefers .kody/tasks/ scan over comment-based lookup", () => {
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks", "42-260327-100000"))

    // Comment has a different (older) task-id
    vi.mocked(getIssueComments).mockReturnValue([
      { body: "🚀 Kody pipeline started: `42-260326-090000`", created_at: "2026-03-26T09:00:00Z" },
    ])

    const result = resolveTaskIdForCommand(42, tmpDir)
    expect(result).toBe("42-260327-100000")
  })

  it("falls back to issue comments when .kody/tasks/ has no match", () => {
    // No matching task directory
    vi.mocked(getIssueComments).mockReturnValue([
      { body: "🚀 Kody pipeline started: `42-260327-100000`", created_at: "2026-03-27T10:00:00Z" },
    ])

    const result = resolveTaskIdForCommand(42, tmpDir)
    expect(result).toBe("42-260327-100000")
  })

  it("returns null when no task found anywhere", () => {
    const result = resolveTaskIdForCommand(42, tmpDir)
    expect(result).toBeNull()
  })
})
