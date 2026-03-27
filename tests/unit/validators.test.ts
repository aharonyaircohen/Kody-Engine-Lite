import { describe, it, expect } from "vitest"
import { validateTaskJson, validatePlanMd, validateReviewMd, stripFences } from "../../src/validators.js"

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

  it("passes with JSON wrapped in markdown fences", () => {
    const content = '```json\n{"task_type":"feature","title":"X","description":"Y","scope":[],"risk_level":"low"}\n```'
    expect(validateTaskJson(content)).toEqual({ valid: true })
  })

  it("passes with JSON wrapped in fences and trailing whitespace", () => {
    const content = '```json\n{"task_type":"feature","title":"X","description":"Y","scope":[],"risk_level":"low"}\n```  '
    expect(validateTaskJson(content)).toEqual({ valid: true })
  })

  it("fails with non-JSON markdown content", () => {
    const result = validateTaskJson("## Task Complete\nThe task is done.")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Invalid JSON/)
  })
})

describe("stripFences", () => {
  it("strips json fences", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it("returns plain JSON unchanged", () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}')
  })

  it("handles fences with trailing whitespace", () => {
    expect(stripFences('```json\n{"a":1}\n```  ')).toBe('{"a":1}')
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
