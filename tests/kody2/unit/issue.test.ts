import { describe, it, expect } from "vitest"
import { truncate } from "../../../src-v2/issue.js"

describe("issue: truncate", () => {
  it("returns string unchanged when within limit", () => {
    expect(truncate("hello", 100)).toBe("hello")
  })

  it("truncates long strings with ellipsis suffix", () => {
    const result = truncate("x".repeat(100), 50)
    expect(result.startsWith("x".repeat(50))).toBe(true)
    expect(result).toMatch(/\+50 chars/)
  })

  it("does not error on empty string", () => {
    expect(truncate("", 100)).toBe("")
  })

  it("handles exact-length input", () => {
    expect(truncate("12345", 5)).toBe("12345")
  })
})
