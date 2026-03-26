import { describe, it, expect } from "vitest"
import { validateTaskJson, validatePlanMd, validateReviewMd } from "../../src/validators.js"

describe("validateTaskJson", () => {
  it("passes with all 5 required fields", () => {
    const json = JSON.stringify({
      task_type: "feature",
      title: "Add sum function",
      description: "Create a sum function",
      scope: ["src/math.ts"],
      risk_level: "low",
    })
    expect(validateTaskJson(json)).toEqual({ valid: true })
  })

  it("fails with missing field", () => {
    const json = JSON.stringify({ task_type: "feature", title: "X" })
    const result = validateTaskJson(json)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Missing field/)
  })

  it("fails with invalid JSON", () => {
    const result = validateTaskJson("not json")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Invalid JSON/)
  })

  it("fails with empty string", () => {
    const result = validateTaskJson("")
    expect(result.valid).toBe(false)
  })
})

describe("validatePlanMd", () => {
  it("passes with h2 sections", () => {
    expect(validatePlanMd("## Step 1: Do something\nDetails here")).toEqual({ valid: true })
  })

  it("fails when too short", () => {
    const result = validatePlanMd("short")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/too short/)
  })

  it("fails without h2 section", () => {
    const result = validatePlanMd("This is a plan without any markdown headers at all and is long enough")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/no markdown h2/)
  })
})

describe("validateReviewMd", () => {
  it("passes with PASS verdict", () => {
    expect(validateReviewMd("## Verdict: PASS\nAll good")).toEqual({ valid: true })
  })

  it("passes with FAIL verdict", () => {
    expect(validateReviewMd("## Verdict: FAIL\nIssues found")).toEqual({ valid: true })
  })

  it("passes case-insensitive", () => {
    expect(validateReviewMd("The code passes all checks")).toEqual({ valid: true })
  })

  it("fails without verdict", () => {
    const result = validateReviewMd("This review has no verdict keyword")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pass.*fail/i)
  })
})
