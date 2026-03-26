import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { injectTaskContext, resolveModel, buildFullPrompt } from "../../src/context.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

describe("injectTaskContext", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-context-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("replaces {{TASK_CONTEXT}} with task info", () => {
    fs.writeFileSync(path.join(tmpDir, "task.md"), "Add a sum function")
    const result = injectTaskContext("Prompt: {{TASK_CONTEXT}}", "test-1", tmpDir)
    expect(result).toContain("Add a sum function")
    expect(result).toContain("test-1")
    expect(result).not.toContain("{{TASK_CONTEXT}}")
  })

  it("handles missing artifacts gracefully", () => {
    const result = injectTaskContext("Prompt: {{TASK_CONTEXT}}", "test-2", tmpDir)
    expect(result).toContain("test-2")
    expect(result).not.toContain("{{TASK_CONTEXT}}")
  })

  it("includes task.json classification", () => {
    fs.writeFileSync(
      path.join(tmpDir, "task.json"),
      JSON.stringify({ task_type: "feature", title: "Test", risk_level: "low" }),
    )
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-3", tmpDir)
    expect(result).toContain("feature")
    expect(result).toContain("low")
  })

  it("truncates plan.md to 1500 chars", () => {
    fs.writeFileSync(path.join(tmpDir, "plan.md"), "x".repeat(3000))
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-4", tmpDir)
    expect(result).toContain("...")
    expect(result.length).toBeLessThan(3000)
  })

  it("includes feedback when provided", () => {
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-5", tmpDir, "Fix the edge case")
    expect(result).toContain("Human Feedback")
    expect(result).toContain("Fix the edge case")
  })

  it("excludes feedback section when not provided", () => {
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-6", tmpDir)
    expect(result).not.toContain("Human Feedback")
  })
})

describe("resolveModel", () => {
  beforeEach(() => resetProjectConfig())
  afterEach(() => resetProjectConfig())

  it("maps tier to default model name", () => {
    // Use empty config dir so defaults (haiku/sonnet/opus) apply
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-defaults-"))
    setConfigDir(emptyDir)
    expect(resolveModel("cheap")).toBe("haiku")
    expect(resolveModel("mid")).toBe("sonnet")
    expect(resolveModel("strong")).toBe("opus")
    fs.rmSync(emptyDir, { recursive: true, force: true })
  })

  it("falls back to sonnet for unknown tier", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-defaults-"))
    setConfigDir(emptyDir)
    expect(resolveModel("unknown")).toBe("sonnet")
    fs.rmSync(emptyDir, { recursive: true, force: true })
  })

  it("uses config modelMap when available", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-model-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({ agent: { modelMap: { cheap: "custom-cheap", mid: "custom-mid", strong: "custom-strong" } } }),
    )
    setConfigDir(tmpDir)
    expect(resolveModel("cheap")).toBe("custom-cheap")
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns stage name when usePerStageRouting is true", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-model-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({ agent: { usePerStageRouting: true } }),
    )
    setConfigDir(tmpDir)
    expect(resolveModel("mid", "plan")).toBe("plan")
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
