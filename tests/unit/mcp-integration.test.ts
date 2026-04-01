import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { getProjectConfig, resetProjectConfig, setConfigDir } from "../../src/config.js"
import { buildMcpConfigJson, isMcpEnabledForStage } from "../../src/mcp-config.js"
import { buildFullPrompt } from "../../src/context.js"

describe("MCP config loading from kody.config.json", () => {
  let tmpDir: string

  beforeEach(() => {
    resetProjectConfig()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-mcp-config-"))
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns undefined mcp when not in config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({ agent: {} }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.mcp).toBeUndefined()
  })

  it("loads mcp config from kody.config.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        mcp: {
          enabled: true,
          servers: {
            playwright: {
              command: "npx",
              args: ["@playwright/mcp@latest"],
            },
          },
        },
      }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.mcp).toBeDefined()
    expect(config.mcp!.enabled).toBe(true)
    expect(config.mcp!.servers.playwright.command).toBe("npx")
  })

  it("defaults stages when not specified in config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
        },
      }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.mcp!.stages).toEqual(["build", "verify", "review", "review-fix"])
  })

  it("preserves custom stages from config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build"],
        },
      }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.mcp!.stages).toEqual(["build"])
  })

  it("buildMcpConfigJson works with loaded config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        mcp: {
          enabled: true,
          servers: {
            playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
          },
        },
      }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    const json = buildMcpConfigJson(config.mcp)
    expect(json).toBeDefined()
    const parsed = JSON.parse(json!)
    expect(parsed.mcpServers.playwright).toBeDefined()
  })

  it("isMcpEnabledForStage works with loaded config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build", "review"],
        },
      }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(isMcpEnabledForStage("build", config.mcp)).toBe(true)
    expect(isMcpEnabledForStage("review", config.mcp)).toBe(true)
    expect(isMcpEnabledForStage("verify", config.mcp)).toBe(false)
    expect(isMcpEnabledForStage("taskify", config.mcp)).toBe(false)
  })
})

describe("MCP browser guidance in prompts", () => {
  let projectDir: string
  let taskDir: string

  beforeEach(() => {
    resetProjectConfig()
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-mcp-prompt-"))
    taskDir = path.join(projectDir, ".kody", "tasks", "test-task")
    fs.mkdirSync(taskDir, { recursive: true })

    // Create minimal task artifacts
    fs.writeFileSync(path.join(taskDir, "task.md"), "Add a button component")
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ title: "Add button", task_type: "feature", risk_level: "low", hasUI: true }),
    )

    // Create prompt template
    const stepsDir = path.join(projectDir, ".kody", "steps")
    fs.mkdirSync(stepsDir, { recursive: true })
    fs.writeFileSync(path.join(stepsDir, "build.md"), "You are a code builder.\n\n{{TASK_CONTEXT}}")
    fs.writeFileSync(path.join(stepsDir, "review.md"), "You are a code reviewer.\n\n{{TASK_CONTEXT}}")
    fs.writeFileSync(path.join(stepsDir, "taskify.md"), "You are a task classifier.\n\n{{TASK_CONTEXT}}")
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    resetProjectConfig()
  })

  it("includes browser guidance when MCP enabled and hasUI", () => {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
          stages: ["build", "review"],
        },
      }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(prompt).toContain("Browser Visual Verification")
    expect(prompt).toContain("MANDATORY")
  })

  it("excludes browser guidance when MCP disabled", () => {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: false,
          servers: { playwright: { command: "npx" } },
        },
      }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(prompt).not.toContain("Browser Visual Verification")
  })

  it("excludes browser guidance for stages not in MCP stages list", () => {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build"],
        },
      }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("taskify", "test-task", taskDir, projectDir)
    expect(prompt).not.toContain("Browser Visual Verification")
  })

  it("excludes browser guidance when scope contains only backend files", () => {
    // Override task.json with backend-only scope
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ title: "Add retry util", task_type: "feature", risk_level: "low", scope: ["src/utils/retry.ts", "src/lib/db.ts"] }),
    )
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build"],
        },
      }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(prompt).not.toContain("Browser Visual Verification")
  })

  it("includes browser guidance when scope is absent (defaults to enabled)", () => {
    // task.json without scope field — MCP guidance should still appear (safe default)
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ title: "Add button", task_type: "feature", risk_level: "low" }),
    )
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build"],
        },
      }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(prompt).toContain("Browser Visual Verification")
  })

  it("includes stage-specific guidance for build and review", () => {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build", "review"],
        },
      }),
    )
    setConfigDir(projectDir)
    const buildPrompt = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(buildPrompt).toContain("MANDATORY for UI tasks")
    expect(buildPrompt).toContain("browser_navigate")
    expect(buildPrompt).toContain("browser_snapshot")
    expect(buildPrompt).toContain("browser_click")
    expect(buildPrompt).toContain("browser_type")
    expect(buildPrompt).toContain("Test interactions")

    resetProjectConfig()
    setConfigDir(projectDir)
    const reviewPrompt = buildFullPrompt("review", "test-task", taskDir, projectDir)
    expect(reviewPrompt).toContain("MANDATORY for UI review")
    expect(reviewPrompt).toContain("browser_navigate")
    expect(reviewPrompt).toContain("browser_click")
    expect(reviewPrompt).toContain("Test interactions")
  })

  it("includes devServer info when configured", () => {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build"],
          devServer: {
            command: "pnpm dev",
            url: "http://localhost:3000",
          },
        },
      }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(prompt).toContain("pnpm dev")
    expect(prompt).toContain("http://localhost:3000")
  })

  it("uses generic dev server guidance when devServer not configured", () => {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: {},
        contextTiers: { enabled: false },
        mcp: {
          enabled: true,
          servers: { playwright: { command: "npx" } },
          stages: ["build"],
        },
      }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(prompt).toContain("Check package.json for the dev command")
  })
})
