import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../src-v2/entry.js"

describe("entry: parseArgs", () => {
  it("returns help when no args", () => {
    expect(parseArgs([]).command).toBe("help")
  })

  it("recognizes help variants", () => {
    expect(parseArgs(["help"]).command).toBe("help")
    expect(parseArgs(["--help"]).command).toBe("help")
    expect(parseArgs(["-h"]).command).toBe("help")
  })

  it("recognizes version variants", () => {
    expect(parseArgs(["version"]).command).toBe("version")
    expect(parseArgs(["--version"]).command).toBe("version")
    expect(parseArgs(["-v"]).command).toBe("version")
  })

  it("parses run --issue", () => {
    const a = parseArgs(["run", "--issue", "42"])
    expect(a.command).toBe("run")
    expect(a.issueNumber).toBe(42)
    expect(a.errors).toEqual([])
  })

  it("requires --issue for run", () => {
    const a = parseArgs(["run"])
    expect(a.command).toBe("run")
    expect(a.errors.length).toBeGreaterThan(0)
  })

  it("rejects non-positive issue numbers", () => {
    expect(parseArgs(["run", "--issue", "0"]).errors.length).toBeGreaterThan(0)
    expect(parseArgs(["run", "--issue", "abc"]).errors.length).toBeGreaterThan(0)
  })

  it("parses verbose / quiet / dry-run flags", () => {
    const a = parseArgs(["run", "--issue", "1", "--verbose", "--dry-run"])
    expect(a.verbose).toBe(true)
    expect(a.dryRun).toBe(true)
  })

  it("parses --cwd", () => {
    const a = parseArgs(["run", "--issue", "1", "--cwd", "/tmp/foo"])
    expect(a.cwd).toBe("/tmp/foo")
  })

  it("rejects unknown commands", () => {
    expect(parseArgs(["frobnicate"]).errors.length).toBeGreaterThan(0)
  })

  it("rejects unknown flags", () => {
    const a = parseArgs(["run", "--issue", "1", "--bogus"])
    expect(a.errors.some((e) => e.includes("--bogus"))).toBe(true)
  })
})
