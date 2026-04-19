import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../../src-v2/entry.js"

describe("entry: fix-ci args", () => {
  it("parses --pr", () => {
    const a = parseArgs(["fix-ci", "--pr", "42"])
    expect(a.command).toBe("fix-ci")
    expect(a.prNumber).toBe(42)
    expect(a.errors).toEqual([])
  })

  it("parses --run-id", () => {
    const a = parseArgs(["fix-ci", "--pr", "1", "--run-id", "123456789"])
    expect(a.runId).toBe("123456789")
  })

  it("requires --pr", () => {
    const a = parseArgs(["fix-ci"])
    expect(a.errors.some((e) => e.includes("--pr"))).toBe(true)
  })

  it("rejects unknown flags", () => {
    const a = parseArgs(["fix-ci", "--pr", "1", "--bogus"])
    expect(a.errors.some((e) => e.includes("--bogus"))).toBe(true)
  })
})
