import { describe, it, expect } from "vitest"
import { parseCommand } from "../../src/verify-runner.js"

describe("parseCommand", () => {
  it("splits simple command", () => {
    expect(parseCommand("pnpm -s test")).toEqual(["pnpm", "-s", "test"])
  })

  it("handles double-quoted arguments", () => {
    expect(parseCommand('pnpm -s "test:unit"')).toEqual(["pnpm", "-s", "test:unit"])
  })

  it("handles single-quoted arguments", () => {
    expect(parseCommand("pnpm -s 'test:unit'")).toEqual(["pnpm", "-s", "test:unit"])
  })

  it("handles multiple spaces between args", () => {
    expect(parseCommand("pnpm   -s   test")).toEqual(["pnpm", "-s", "test"])
  })

  it("handles empty string", () => {
    expect(parseCommand("")).toEqual([])
  })

  it("handles whitespace-only string", () => {
    expect(parseCommand("   ")).toEqual([])
  })

  it("handles quoted path with spaces", () => {
    expect(parseCommand('"/path/to my/tool" --flag')).toEqual(["/path/to my/tool", "--flag"])
  })

  it("handles mixed quotes", () => {
    expect(parseCommand(`pnpm -s "test" '--verbose'`)).toEqual(["pnpm", "-s", "test", "--verbose"])
  })

  it("handles command with no args", () => {
    expect(parseCommand("tsc")).toEqual(["tsc"])
  })

  it("handles tabs as separators", () => {
    expect(parseCommand("pnpm\t-s\ttest")).toEqual(["pnpm", "-s", "test"])
  })
})
