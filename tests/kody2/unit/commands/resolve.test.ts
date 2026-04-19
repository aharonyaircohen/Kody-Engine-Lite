import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../../src-v2/entry.js"

describe("entry: resolve args", () => {
  it("parses --pr", () => {
    const a = parseArgs(["resolve", "--pr", "42"])
    expect(a.command).toBe("resolve")
    expect(a.prNumber).toBe(42)
    expect(a.errors).toEqual([])
  })

  it("requires --pr", () => {
    const a = parseArgs(["resolve"])
    expect(a.errors.some((e) => e.includes("--pr"))).toBe(true)
  })

  it("rejects non-positive --pr", () => {
    expect(parseArgs(["resolve", "--pr", "0"]).errors.length).toBeGreaterThan(0)
  })

  it("rejects unknown flags", () => {
    const a = parseArgs(["resolve", "--pr", "1", "--bogus"])
    expect(a.errors.some((e) => e.includes("--bogus"))).toBe(true)
  })
})
