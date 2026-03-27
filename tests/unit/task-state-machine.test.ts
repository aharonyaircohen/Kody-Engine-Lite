import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { resolveTaskAction, resolveForIssue } from "../../src/cli/task-state.js"

/**
 * Tests for the state machine approach to task resolution.
 *
 * Design: `@kody` is the only trigger needed. The pipeline reads existing
 * state and decides what to do:
 *
 *   @kody on issue #37:
 *     └─ find latest task for issue #37
 *         ├─ no task exists → start fresh pipeline
 *         ├─ task completed → skip ("already completed, PR #47")
 *         ├─ task failed at stage X → resume from X
 *         └─ task paused → resume from paused stage
 */

interface TaskState {
  taskId: string
  state: "running" | "completed" | "failed"
  stages: Record<string, { state: string; error?: string }>
}

describe("resolveTaskAction", () => {
  it("starts fresh when no previous task exists", () => {
    const result = resolveTaskAction(37, null, null)
    expect(result.action).toBe("start-fresh")
    expect(result.taskId).toMatch(/^37-/)
  })

  it("skips when task already completed", () => {
    const state: TaskState = {
      taskId: "37-260327-100000",
      state: "completed",
      stages: {
        taskify: { state: "completed" },
        build: { state: "completed" },
        verify: { state: "completed" },
        ship: { state: "completed" },
      },
    }
    const result = resolveTaskAction(37, "37-260327-100000", state)
    expect(result).toEqual({ action: "already-completed", taskId: "37-260327-100000" })
  })

  it("resumes from failed stage", () => {
    const state: TaskState = {
      taskId: "37-260327-100000",
      state: "failed",
      stages: {
        taskify: { state: "completed" },
        build: { state: "completed" },
        verify: { state: "failed", error: "lint error" },
        ship: { state: "pending" },
      },
    }
    const result = resolveTaskAction(37, "37-260327-100000", state)
    expect(result).toEqual({ action: "resume", taskId: "37-260327-100000", fromStage: "verify" })
  })

  it("resumes from first pending stage", () => {
    const state: TaskState = {
      taskId: "37-260327-100000",
      state: "failed",
      stages: {
        taskify: { state: "completed" },
        plan: { state: "completed" },
        build: { state: "pending" },
        verify: { state: "pending" },
      },
    }
    const result = resolveTaskAction(37, "37-260327-100000", state)
    expect(result).toEqual({ action: "resume", taskId: "37-260327-100000", fromStage: "build" })
  })

  it("resumes after paused stage (next stage)", () => {
    const state: TaskState = {
      taskId: "37-260327-100000",
      state: "failed",
      stages: {
        taskify: { state: "completed" },
        plan: { state: "failed", error: "paused: waiting for answers" },
        build: { state: "pending" },
      },
    }
    const result = resolveTaskAction(37, "37-260327-100000", state)
    expect(result).toEqual({ action: "resume", taskId: "37-260327-100000", fromStage: "build" })
  })

  it("guards against concurrent triggers (already running)", () => {
    const state: TaskState = {
      taskId: "37-260327-100000",
      state: "running",
      stages: {
        taskify: { state: "completed" },
        build: { state: "running" },
      },
    }
    const result = resolveTaskAction(37, "37-260327-100000", state)
    expect(result).toEqual({ action: "already-running", taskId: "37-260327-100000" })
  })

  it("falls back to taskify when failed but all stages look completed", () => {
    const state: TaskState = {
      taskId: "37-260327-100000",
      state: "failed",
      stages: {
        taskify: { state: "completed" },
        build: { state: "completed" },
        verify: { state: "completed" },
        ship: { state: "completed" },
      },
    }
    const result = resolveTaskAction(37, "37-260327-100000", state)
    expect(result).toEqual({ action: "resume", taskId: "37-260327-100000", fromStage: "taskify" })
  })

  it("reuses existing task ID, never generates new one for existing task", () => {
    const state: TaskState = {
      taskId: "37-260327-100000",
      state: "failed",
      stages: { verify: { state: "failed" } },
    }
    const result = resolveTaskAction(37, "37-260327-100000", state)
    expect(result.taskId).toBe("37-260327-100000")
    expect(result.taskId).not.toContain("120000") // not the generated one
  })
})

vi.mock("../../src/cli/task-resolution.js", () => ({
  findLatestTaskForIssue: vi.fn(() => null),
  generateTaskId: vi.fn(() => "260327-200000"),
}))
vi.mock("../../src/github-api.js", () => ({
  getIssueLabels: vi.fn(() => []),
}))

import { findLatestTaskForIssue } from "../../src/cli/task-resolution.js"
import { getIssueLabels } from "../../src/github-api.js"

describe("resolveForIssue — CI label fallback", () => {
  beforeEach(() => {
    vi.mocked(findLatestTaskForIssue).mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("resumes from build when kody:waiting label exists (question gate loop fix)", () => {
    vi.mocked(getIssueLabels).mockReturnValue(["kody:waiting"])

    const result = resolveForIssue(60, "/tmp/fake-project")
    expect(result.action).toBe("resume")
    if (result.action === "resume") {
      expect(result.fromStage).toBe("build")
      expect(result.taskId).toMatch(/^60-/)
    }
  })

  it("returns already-completed for kody:done (takes priority over kody:waiting)", () => {
    vi.mocked(getIssueLabels).mockReturnValue(["kody:done", "kody:waiting"])

    const result = resolveForIssue(60, "/tmp/fake-project")
    expect(result.action).toBe("already-completed")
  })

  it("starts fresh when no relevant labels exist", () => {
    vi.mocked(getIssueLabels).mockReturnValue(["bug", "enhancement"])

    const result = resolveForIssue(60, "/tmp/fake-project")
    expect(result.action).toBe("start-fresh")
  })
})
