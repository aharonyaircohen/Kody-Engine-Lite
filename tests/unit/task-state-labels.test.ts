import { describe, it, expect } from "vitest"

/**
 * Tests for GitHub label-based task state detection in CI.
 *
 * In CI, .tasks/ doesn't persist across runs. The state machine falls
 * back to checking GitHub labels (kody:done, kody:failed) to determine
 * if the issue has already been processed.
 */

describe("label-based task state detection", () => {
  function resolveFromLabels(
    labels: string[],
    issueNumber: number,
  ): { action: string; taskId?: string } {
    if (labels.includes("kody:done")) {
      return { action: "already-completed", taskId: `${issueNumber}-unknown` }
    }
    return { action: "start-fresh" }
  }

  it("detects completed task from kody:done label", () => {
    const result = resolveFromLabels(["kody:done", "kody:feature"], 37)
    expect(result.action).toBe("already-completed")
  })

  it("starts fresh when no kody:done label", () => {
    const result = resolveFromLabels(["kody:feature"], 37)
    expect(result.action).toBe("start-fresh")
  })

  it("starts fresh when no labels at all", () => {
    const result = resolveFromLabels([], 37)
    expect(result.action).toBe("start-fresh")
  })

  it("kody:failed does not block a new run", () => {
    const result = resolveFromLabels(["kody:failed", "kody:feature"], 37)
    expect(result.action).toBe("start-fresh")
  })

  it("kody:done takes precedence over kody:failed", () => {
    const result = resolveFromLabels(["kody:done", "kody:failed"], 37)
    expect(result.action).toBe("already-completed")
  })
})
