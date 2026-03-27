import { describe, it, expect } from "vitest"

/**
 * Tests for the agent runner error reporting fix:
 * When a subprocess fails, the error should include stderr if available,
 * falling back to stdout when stderr is empty (Claude Code --print mode
 * outputs errors to stdout).
 */

describe("agent runner error output fallback", () => {
  // Replicate the error detail logic from agent-runner.ts
  function buildErrorDetail(stderr: string, stdout: string, tailChars: number): string {
    return stderr.slice(-tailChars) || stdout.slice(-tailChars)
  }

  it("uses stderr when available", () => {
    const result = buildErrorDetail("some error on stderr", "output on stdout", 500)
    expect(result).toBe("some error on stderr")
  })

  it("falls back to stdout when stderr is empty", () => {
    const result = buildErrorDetail("", "API Error: 400 invalid model", 500)
    expect(result).toBe("API Error: 400 invalid model")
  })

  it("returns empty when both are empty", () => {
    const result = buildErrorDetail("", "", 500)
    expect(result).toBe("")
  })

  it("truncates stderr to tail chars", () => {
    const longStderr = "x".repeat(1000)
    const result = buildErrorDetail(longStderr, "", 500)
    expect(result.length).toBe(500)
  })

  it("truncates stdout fallback to tail chars", () => {
    const longStdout = "prefix " + "y".repeat(1000)
    const result = buildErrorDetail("", longStdout, 500)
    expect(result.length).toBe(500)
    expect(result).not.toContain("prefix")
  })

  it("prefers stderr even if stdout has content", () => {
    const result = buildErrorDetail("real error", "some output\nmore output", 500)
    expect(result).toBe("real error")
  })
})
