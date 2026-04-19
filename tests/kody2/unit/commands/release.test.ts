import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../../src-v2/entry.js"
import { bumpVersion } from "../../../../src-v2/commands/release.js"

describe("release: bumpVersion", () => {
  it("patches", () => {
    expect(bumpVersion("0.1.2", "patch")).toBe("0.1.3")
    expect(bumpVersion("1.0.0", "patch")).toBe("1.0.1")
  })
  it("bumps minor and resets patch", () => {
    expect(bumpVersion("0.7.4", "minor")).toBe("0.8.0")
  })
  it("bumps major and resets minor+patch", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0")
  })
  it("ignores suffixes like -rc.1", () => {
    expect(bumpVersion("0.1.2-rc.1", "patch")).toBe("0.1.3")
  })
  it("throws on invalid input", () => {
    expect(() => bumpVersion("foo", "patch")).toThrow(/cannot parse version/)
  })
})

describe("entry: release args", () => {
  it("defaults to patch bump", () => {
    const a = parseArgs(["release"])
    expect(a.command).toBe("release")
    expect(a.bump).toBe("patch")
    expect(a.errors).toEqual([])
  })
  it("parses --bump", () => {
    expect(parseArgs(["release", "--bump", "minor"]).bump).toBe("minor")
    expect(parseArgs(["release", "--bump", "major"]).bump).toBe("major")
  })
  it("rejects bad --bump value", () => {
    const a = parseArgs(["release", "--bump", "bogus"])
    expect(a.errors.some((e) => e.includes("--bump"))).toBe(true)
  })
  it("parses --dry-run", () => {
    expect(parseArgs(["release", "--dry-run"]).dryRun).toBe(true)
  })
  it("rejects unknown flags", () => {
    expect(parseArgs(["release", "--bogus"]).errors.length).toBeGreaterThan(0)
  })
})
