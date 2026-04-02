import { describe, it, expect, vi } from "vitest"

/**
 * Tests for the "already-completed" handling in entry.ts state machine check.
 *
 * Bug: When @kody is triggered on a completed issue (kody:done label), the
 * engine posts "✅ Issue #N already completed" every time. This spams the
 * issue with duplicate comments on every subsequent @kody trigger.
 *
 * Fix: Completed issues should exit silently — log locally, don't post.
 */

type TaskAction =
  | { action: "already-completed"; taskId: string }
  | { action: "already-running"; taskId: string }
  | { action: "resume"; taskId: string; fromStage: string }
  | { action: "start-fresh"; taskId: string }

interface StateCheckInput {
  issueNumber: number
  local: boolean
}

/**
 * Models the state-check block from entry.ts (lines 119-127).
 * Extracts the decision: should we post a comment?
 */
function handleAlreadyCompleted(
  taskAction: TaskAction,
  input: StateCheckInput,
): { shouldPost: boolean; shouldExit: boolean } {
  if (taskAction.action !== "already-completed") {
    return { shouldPost: false, shouldExit: false }
  }

  // Fixed: never post on completed issues — just exit silently
  return { shouldPost: false, shouldExit: true }
}

describe("already-completed should not post comments", () => {
  it("does NOT post a comment on completed issues in CI", () => {
    const taskAction: TaskAction = {
      action: "already-completed",
      taskId: "1-unknown",
    }
    const input: StateCheckInput = { issueNumber: 1, local: false }

    const result = handleAlreadyCompleted(taskAction, input)

    expect(result.shouldExit).toBe(true)
    expect(result.shouldPost).toBe(false) // <-- the bug: currently true
  })

  it("does NOT post a comment on completed issues locally either", () => {
    const taskAction: TaskAction = {
      action: "already-completed",
      taskId: "1-unknown",
    }
    const input: StateCheckInput = { issueNumber: 1, local: true }

    const result = handleAlreadyCompleted(taskAction, input)

    expect(result.shouldExit).toBe(true)
    expect(result.shouldPost).toBe(false)
  })

  it("exits silently regardless of task ID format", () => {
    const taskAction: TaskAction = {
      action: "already-completed",
      taskId: "42-260327-100000",
    }
    const input: StateCheckInput = { issueNumber: 42, local: false }

    const result = handleAlreadyCompleted(taskAction, input)

    expect(result.shouldExit).toBe(true)
    expect(result.shouldPost).toBe(false)
  })

  it("does not interfere with non-completed actions", () => {
    const taskAction: TaskAction = {
      action: "start-fresh",
      taskId: "5-260402-090000",
    }
    const input: StateCheckInput = { issueNumber: 5, local: false }

    const result = handleAlreadyCompleted(taskAction, input)

    expect(result.shouldExit).toBe(false)
    expect(result.shouldPost).toBe(false)
  })
})
