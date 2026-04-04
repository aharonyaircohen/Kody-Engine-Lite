import { describe, it, expect } from "vitest"
import { getArg } from "../../src/bin/cli.js"

describe("getArg", () => {
  it("parses --flag=value (equals form)", () => {
    expect(getArg(["bootstrap", "--model=opus-4-6"], "--model")).toBe("opus-4-6")
  })

  it("parses --flag value (space form)", () => {
    expect(getArg(["bootstrap", "--model", "opus-4-6"], "--model")).toBe("opus-4-6")
  })

  it("returns undefined when flag is missing", () => {
    expect(getArg(["bootstrap", "--force"], "--model")).toBeUndefined()
  })

  it("returns undefined when flag has no value (next arg is another flag)", () => {
    expect(getArg(["bootstrap", "--model", "--force"], "--model")).toBeUndefined()
  })

  it("returns undefined when flag is last arg with no value", () => {
    expect(getArg(["bootstrap", "--model"], "--model")).toBeUndefined()
  })

  it("handles multiple flags correctly", () => {
    const args = ["bootstrap", "--provider=claude", "--model=opus-4-6", "--force"]
    expect(getArg(args, "--provider")).toBe("claude")
    expect(getArg(args, "--model")).toBe("opus-4-6")
  })

  it("handles equals form with complex values", () => {
    expect(getArg(["bootstrap", "--model=claude-opus-4-6"], "--model")).toBe("claude-opus-4-6")
  })

  it("prefers equals form when both present", () => {
    const args = ["--model=from-equals", "--model", "from-space"]
    expect(getArg(args, "--model")).toBe("from-equals")
  })
})
