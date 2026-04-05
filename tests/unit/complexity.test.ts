import { describe, it, expect } from "vitest"
import { filterByComplexity, isValidComplexity } from "../../src/pipeline/complexity.js"
import { STAGES } from "../../src/definitions.js"

describe("filterByComplexity", () => {
  it("low complexity skips plan, review, review-fix", () => {
    const active = filterByComplexity(STAGES, "low")
    const names = active.map((s) => s.name)
    expect(names).not.toContain("plan")
    expect(names).not.toContain("review")
    expect(names).not.toContain("review-fix")
    expect(names).toContain("taskify")
    expect(names).toContain("build")
    expect(names).toContain("verify")
    expect(names).toContain("ship")
  })

  it("medium complexity skips only review-fix", () => {
    const active = filterByComplexity(STAGES, "medium")
    const names = active.map((s) => s.name)
    expect(names).not.toContain("review-fix")
    expect(names).toContain("plan")
    expect(names).toContain("review")
  })

  it("high complexity runs all stages", () => {
    const active = filterByComplexity(STAGES, "high")
    expect(active.length).toBe(STAGES.length)
  })

  it("unknown complexity runs all stages", () => {
    const active = filterByComplexity(STAGES, "unknown")
    expect(active.length).toBe(STAGES.length)
  })

  it("hotfix complexity runs only build, verify, ship", () => {
    const active = filterByComplexity(STAGES, "hotfix")
    const names = active.map((s) => s.name)
    expect(names).toEqual(["build", "verify", "ship"])
  })
})

describe("isValidComplexity", () => {
  it("returns true for valid values", () => {
    expect(isValidComplexity("low")).toBe(true)
    expect(isValidComplexity("medium")).toBe(true)
    expect(isValidComplexity("high")).toBe(true)
    expect(isValidComplexity("hotfix")).toBe(true)
  })

  it("returns false for invalid values", () => {
    expect(isValidComplexity("unknown")).toBe(false)
    expect(isValidComplexity("")).toBe(false)
    expect(isValidComplexity("critical")).toBe(false)
  })
})
