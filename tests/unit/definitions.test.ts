import { describe, it, expect } from "vitest"
import { STAGES, getStage } from "../../src/definitions.js"

describe("STAGES", () => {
  it("has 7 stages", () => {
    expect(STAGES).toHaveLength(7)
  })

  it("stages are in correct order", () => {
    const names = STAGES.map((s) => s.name)
    expect(names).toEqual(["taskify", "plan", "build", "verify", "review", "review-fix", "ship"])
  })

  it("each stage has required fields", () => {
    for (const stage of STAGES) {
      expect(stage).toHaveProperty("name")
      expect(stage).toHaveProperty("type")
      expect(stage).toHaveProperty("modelTier")
      expect(stage).toHaveProperty("timeout")
      expect(stage).toHaveProperty("maxRetries")
    }
  })

  it("plan and review use strong model for reasoning", () => {
    expect(getStage("plan")?.modelTier).toBe("strong")
    expect(getStage("review")?.modelTier).toBe("strong")
  })

  it("build and review-fix use mid model for execution", () => {
    expect(getStage("build")?.modelTier).toBe("mid")
    expect(getStage("review-fix")?.modelTier).toBe("mid")
  })

  it("verify has autofix retry agent", () => {
    expect(getStage("verify")?.retryWithAgent).toBe("autofix")
  })
})

describe("getStage", () => {
  it("returns correct stage by name", () => {
    const stage = getStage("build")
    expect(stage?.name).toBe("build")
    expect(stage?.type).toBe("agent")
  })

  it("returns undefined for unknown stage", () => {
    expect(getStage("nonexistent")).toBeUndefined()
  })
})
