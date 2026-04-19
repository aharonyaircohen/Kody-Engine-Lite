import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../../src-v2/entry.js"

describe("entry: review args", () => {
  it("parses --pr", () => {
    const a = parseArgs(["review", "--pr", "42"])
    expect(a.command).toBe("review")
    expect(a.prNumber).toBe(42)
    expect(a.errors).toEqual([])
  })

  it("requires --pr", () => {
    const a = parseArgs(["review"])
    expect(a.command).toBe("review")
    expect(a.errors.some((e) => e.includes("--pr"))).toBe(true)
  })

  it("rejects non-positive --pr", () => {
    expect(parseArgs(["review", "--pr", "0"]).errors.length).toBeGreaterThan(0)
    expect(parseArgs(["review", "--pr", "abc"]).errors.length).toBeGreaterThan(0)
  })

  it("parses --cwd and verbose/quiet", () => {
    const a = parseArgs(["review", "--pr", "1", "--cwd", "/tmp", "--verbose"])
    expect(a.cwd).toBe("/tmp")
    expect(a.verbose).toBe(true)
  })

  it("rejects unknown flags", () => {
    const a = parseArgs(["review", "--pr", "1", "--bogus"])
    expect(a.errors.some((e) => e.includes("--bogus"))).toBe(true)
  })
})
