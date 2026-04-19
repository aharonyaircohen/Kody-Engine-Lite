import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../../src-v2/entry.js"

describe("entry: fix args", () => {
  it("parses --pr", () => {
    const a = parseArgs(["fix", "--pr", "42"])
    expect(a.command).toBe("fix")
    expect(a.prNumber).toBe(42)
    expect(a.errors).toEqual([])
  })

  it("parses --feedback", () => {
    const a = parseArgs(["fix", "--pr", "1", "--feedback", "rename X to Y"])
    expect(a.feedback).toBe("rename X to Y")
  })

  it("requires --pr", () => {
    const a = parseArgs(["fix"])
    expect(a.errors.some((e) => e.includes("--pr"))).toBe(true)
  })

  it("rejects non-positive --pr", () => {
    expect(parseArgs(["fix", "--pr", "0"]).errors.length).toBeGreaterThan(0)
    expect(parseArgs(["fix", "--pr", "-1"]).errors.length).toBeGreaterThan(0)
  })

  it("rejects unknown flags", () => {
    const a = parseArgs(["fix", "--pr", "1", "--bogus"])
    expect(a.errors.some((e) => e.includes("--bogus"))).toBe(true)
  })
})
