import { describe, it, expect } from "vitest"
import { shouldFailFixModeShip } from "../../src/stages/ship.js"

describe("ship guard: shouldFailFixModeShip", () => {
  it("fix + non-empty feedback + no source change → fail", () => {
    expect(shouldFailFixModeShip("fix", "Add a ping() method", false)).toBe(true)
  })

  it("fix-ci + non-empty feedback + no source change → fail", () => {
    expect(shouldFailFixModeShip("fix-ci", "CI failed with TS2345", false)).toBe(true)
  })

  it("fix + non-empty feedback + source changed → pass", () => {
    expect(shouldFailFixModeShip("fix", "Add a ping() method", true)).toBe(false)
  })

  it("fix + empty/whitespace feedback → never fail (fast path preserved)", () => {
    expect(shouldFailFixModeShip("fix", "", false)).toBe(false)
    expect(shouldFailFixModeShip("fix", undefined, false)).toBe(false)
    expect(shouldFailFixModeShip("fix", "   \n  ", false)).toBe(false)
  })

  it("non-fix commands never trigger the guard", () => {
    expect(shouldFailFixModeShip("full", "Some feedback", false)).toBe(false)
    expect(shouldFailFixModeShip("rerun", "Some feedback", false)).toBe(false)
    expect(shouldFailFixModeShip(undefined, "Some feedback", false)).toBe(false)
  })
})
