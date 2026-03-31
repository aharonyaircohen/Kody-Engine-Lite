import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { STAGES, applyTimeoutOverrides } from "../../src/definitions.js"

describe("applyTimeoutOverrides", () => {
  const originalTimeouts = STAGES.map(s => ({ name: s.name, timeout: s.timeout }))

  afterEach(() => {
    // Restore original timeouts
    for (const orig of originalTimeouts) {
      const stage = STAGES.find(s => s.name === orig.name)!
      stage.timeout = orig.timeout
    }
  })

  it("overrides specific stage timeouts", () => {
    applyTimeoutOverrides({ taskify: 900, build: 3600 })
    expect(STAGES.find(s => s.name === "taskify")!.timeout).toBe(900_000)
    expect(STAGES.find(s => s.name === "build")!.timeout).toBe(3_600_000)
    // Others unchanged
    expect(STAGES.find(s => s.name === "plan")!.timeout).toBe(600_000)
  })

  it("ignores unknown stage names", () => {
    const before = STAGES.map(s => s.timeout)
    applyTimeoutOverrides({ nonexistent: 999 })
    const after = STAGES.map(s => s.timeout)
    expect(after).toEqual(before)
  })

  it("handles empty overrides", () => {
    const before = STAGES.map(s => s.timeout)
    applyTimeoutOverrides({})
    const after = STAGES.map(s => s.timeout)
    expect(after).toEqual(before)
  })
})

// Test that autoDetectComplexity handles override correctly
vi.mock("../../src/github-api.js", () => ({
  setLifecycleLabel: vi.fn(),
  setLabel: vi.fn(),
  postComment: vi.fn(),
}))

import { autoDetectComplexity } from "../../src/pipeline/hooks.js"
import type { PipelineContext, StageDefinition } from "../../src/types.js"

describe("autoDetectComplexity — override logging", () => {
  const taskifyDef: StageDefinition = {
    name: "taskify",
    type: "agent",
    modelTier: "cheap",
    timeout: 600_000,
    maxRetries: 1,
    outputFile: "task.json",
  }

  it("returns override when ctx.input.complexity is set", () => {
    const ctx = {
      input: { complexity: "low", local: true },
      taskDir: "/tmp/fake",
    } as unknown as PipelineContext

    const result = autoDetectComplexity(ctx, taskifyDef)
    expect(result).not.toBeNull()
    expect(result!.complexity).toBe("low")
    expect(result!.activeStages.map(s => s.name)).not.toContain("plan")
    expect(result!.activeStages.map(s => s.name)).not.toContain("review")
  })

  it("returns null for non-taskify stages", () => {
    const ctx = { input: {}, taskDir: "/tmp/fake" } as unknown as PipelineContext
    const planDef = { ...taskifyDef, name: "plan" as const }
    expect(autoDetectComplexity(ctx, planDef)).toBeNull()
  })
})
