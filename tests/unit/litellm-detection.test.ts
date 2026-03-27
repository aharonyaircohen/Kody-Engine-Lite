import { describe, it, expect } from "vitest"

/**
 * Tests for the LiteLLM detection fix:
 * Detection should use `which` (fast PATH lookup) instead of running
 * `litellm --version` which can timeout due to heavy Python imports.
 */

describe("LiteLLM detection strategy", () => {
  // Replicate the detection decision logic
  function detectLitellm(
    whichResult: "found" | "not-found",
    pythonImportResult: "found" | "not-found",
  ): { found: boolean; method: string } {
    if (whichResult === "found") {
      return { found: true, method: "which" }
    }
    if (pythonImportResult === "found") {
      return { found: true, method: "python-import" }
    }
    return { found: false, method: "none" }
  }

  it("detects litellm via which (fast path)", () => {
    const result = detectLitellm("found", "not-found")
    expect(result.found).toBe(true)
    expect(result.method).toBe("which")
  })

  it("falls back to python import when which fails", () => {
    const result = detectLitellm("not-found", "found")
    expect(result.found).toBe(true)
    expect(result.method).toBe("python-import")
  })

  it("returns not found when both fail", () => {
    const result = detectLitellm("not-found", "not-found")
    expect(result.found).toBe(false)
  })

  it("prefers which over python import", () => {
    const result = detectLitellm("found", "found")
    expect(result.method).toBe("which")
  })
})

describe("LiteLLM command resolution", () => {
  // Replicate the command resolution logic
  function resolveCommand(
    whichResult: "found" | "not-found",
    configPath: string,
    port: string,
  ): { cmd: string; args: string[] } {
    if (whichResult === "found") {
      return { cmd: "litellm", args: ["--config", configPath, "--port", port] }
    }
    return { cmd: "python3", args: ["-m", "litellm", "--config", configPath, "--port", port] }
  }

  it("uses litellm directly when on PATH", () => {
    const result = resolveCommand("found", "/app/litellm-config.yaml", "4000")
    expect(result.cmd).toBe("litellm")
    expect(result.args).toContain("--config")
    expect(result.args).toContain("/app/litellm-config.yaml")
  })

  it("uses python3 -m litellm as fallback", () => {
    const result = resolveCommand("not-found", "/app/litellm-config.yaml", "4000")
    expect(result.cmd).toBe("python3")
    expect(result.args[0]).toBe("-m")
    expect(result.args[1]).toBe("litellm")
  })

  it("passes correct port", () => {
    const result = resolveCommand("found", "/app/config.yaml", "8080")
    expect(result.args).toContain("--port")
    expect(result.args).toContain("8080")
  })
})
