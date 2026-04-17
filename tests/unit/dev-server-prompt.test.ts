import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { buildFullPrompt } from "../../src/context.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

/**
 * Tests for dev server startup instructions embedded in the build prompt.
 *
 * The engine injects bash instructions telling Claude Code how to start the
 * project's dev server. These instructions must:
 *   - Use nohup + output redirection so the bash tool doesn't hang
 *   - Poll with a bounded timeout (not just `sleep 5`)
 *   - Detect if the process dies early and show logs
 *   - Tell Claude to proceed without browser verification if the server fails
 *   - Track the PID for reliable cleanup
 */
describe("dev server prompt instructions", () => {
  let projectDir: string
  let taskDir: string

  beforeEach(() => {
    resetProjectConfig()
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-devserver-test-"))
    taskDir = path.join(projectDir, ".kody", "tasks", "test-task")
    fs.mkdirSync(taskDir, { recursive: true })

    // Minimal task artifacts — UI task so browser guidance is included
    fs.writeFileSync(path.join(taskDir, "task.md"), "Add a sorting component to admin page")
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ scope: ["src/components/Sorter.tsx"] }),
    )

    // Step template
    const stepsDir = path.join(projectDir, ".kody", "steps")
    fs.mkdirSync(stepsDir, { recursive: true })
    fs.writeFileSync(path.join(stepsDir, "build.md"), "Build.\n\n{{TASK_CONTEXT}}")
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    resetProjectConfig()
  })

  function buildPromptWithDevServer(devServer: Record<string, unknown>): string {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: { modelMap: { cheap: "claude/test-model-cheap", mid: "claude/test-model-mid", strong: "claude/test-model-strong" } },
        mcp: { devServer },
      }),
    )
    setConfigDir(projectDir)
    return buildFullPrompt("build", "test-task", taskDir, projectDir)
  }

  it("uses nohup with output redirection instead of bare backgrounding", () => {
    const prompt = buildPromptWithDevServer({
      command: "pnpm dev",
      url: "http://localhost:3000",
    })

    // Must NOT use bare `pnpm dev &` which can hang Claude's bash tool
    expect(prompt).not.toMatch(/^pnpm dev &$/m)
    // Must use nohup with output redirect to detach from terminal
    expect(prompt).toContain("nohup")
    expect(prompt).toContain("/tmp/dev-server.log")
  })

  it("polls server readiness with a bounded timeout loop", () => {
    const prompt = buildPromptWithDevServer({
      command: "pnpm dev",
      url: "http://localhost:3000",
      readyTimeout: 45,
    })

    // Must NOT use bare `sleep 5` as the only wait mechanism
    expect(prompt).not.toMatch(/sleep 5\n\`\`\`/)
    // Must poll with curl in a loop
    expect(prompt).toContain("curl")
    // Must use the configured timeout
    expect(prompt).toContain("45")
  })

  it("uses default 30s timeout when readyTimeout not configured", () => {
    const prompt = buildPromptWithDevServer({
      command: "pnpm dev",
      url: "http://localhost:3000",
    })

    expect(prompt).toContain("30")
    expect(prompt).toContain("curl")
  })

  it("detects early process death and shows log output", () => {
    const prompt = buildPromptWithDevServer({
      command: "pnpm dev",
      url: "http://localhost:3000",
    })

    // Must check if process is still alive
    expect(prompt).toContain("kill -0")
    // Must show log tail when process dies
    expect(prompt).toContain("tail")
    expect(prompt).toContain("dev-server.log")
  })

  it("instructs Claude to proceed without browser if server fails", () => {
    const prompt = buildPromptWithDevServer({
      command: "pnpm dev",
      url: "http://localhost:3000",
    })

    // Must have graceful degradation — don't hang, continue with code changes
    expect(prompt).toMatch(/skip browser verification|proceed with.*code/i)
    expect(prompt).toMatch(/do not hang|don't hang/i)
  })

  it("tracks PID for reliable cleanup instead of job control", () => {
    const prompt = buildPromptWithDevServer({
      command: "pnpm dev",
      url: "http://localhost:3000",
    })

    // Must capture PID
    expect(prompt).toContain("DEV_PID")
    // Cleanup must use PID, not job control (%1)
    expect(prompt).toContain("kill $DEV_PID")
    expect(prompt).not.toContain("kill %1")
  })

  it("includes the configured dev server command and url", () => {
    const prompt = buildPromptWithDevServer({
      command: "npm run dev:custom",
      url: "http://localhost:4200",
    })

    expect(prompt).toContain("npm run dev:custom")
    expect(prompt).toContain("http://localhost:4200")
  })

  it("includes browser guidance for build stage with UI task", () => {
    const prompt = buildPromptWithDevServer({
      command: "pnpm dev",
      url: "http://localhost:3000",
    })

    expect(prompt).toContain("Browser Visual Verification")
    // devServer alone uses CLI-based Playwright tools, not MCP
    expect(prompt).toContain("playwright-cli")
  })

  it("no browser guidance when mcp enabled but no servers or devServer configured", () => {
    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({ agent: { modelMap: { cheap: "claude/test-model-cheap", mid: "claude/test-model-mid", strong: "claude/test-model-strong" } }, mcp: { enabled: true } }),
    )
    setConfigDir(projectDir)
    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)

    // No servers and no devServer means no browser guidance at all
    expect(prompt).not.toContain("Browser Visual Verification")
    expect(prompt).not.toContain("mcp__playwright")
    expect(prompt).not.toContain("playwright-cli")
  })
})

describe("engine-managed dev server prompt", () => {
  let projectDir: string
  let taskDir: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetProjectConfig()
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-engine-ds-test-"))
    taskDir = path.join(projectDir, ".kody", "tasks", "test-task")
    fs.mkdirSync(taskDir, { recursive: true })

    fs.writeFileSync(path.join(taskDir, "task.md"), "Add sorting to admin page")
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ scope: ["src/components/Sorter.tsx"] }),
    )
    const stepsDir = path.join(projectDir, ".kody", "steps")
    fs.mkdirSync(stepsDir, { recursive: true })
    fs.writeFileSync(path.join(stepsDir, "build.md"), "Build.\n\n{{TASK_CONTEXT}}")

    fs.writeFileSync(
      path.join(projectDir, "kody.config.json"),
      JSON.stringify({
        agent: { modelMap: { cheap: "claude/test-model-cheap", mid: "claude/test-model-mid", strong: "claude/test-model-strong" } },
        mcp: { devServer: { command: "pnpm dev", url: "http://localhost:3000" } },
      }),
    )
    setConfigDir(projectDir)
  })

  afterEach(() => {
    // Restore original env
    delete process.env.KODY_DEV_SERVER_READY
    delete process.env.KODY_DEV_SERVER_URL
    fs.rmSync(projectDir, { recursive: true, force: true })
    resetProjectConfig()
  })

  it("tells Claude the server is already running when engine started it", () => {
    process.env.KODY_DEV_SERVER_READY = "true"
    process.env.KODY_DEV_SERVER_URL = "http://localhost:3000"

    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)

    expect(prompt).toContain("already running")
    expect(prompt).toContain("http://localhost:3000")
    // Must NOT contain instructions to start the server
    expect(prompt).not.toContain("nohup")
    expect(prompt).not.toContain("pnpm dev")
    expect(prompt).not.toContain("DEV_PID")
  })

  it("tells Claude to skip browser when engine failed to start server", () => {
    process.env.KODY_DEV_SERVER_READY = "false"

    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)

    expect(prompt).toContain("failed to start")
    expect(prompt).toMatch(/skip browser|proceed with code/i)
    // Must NOT contain instructions to start the server
    expect(prompt).not.toContain("nohup")
    expect(prompt).not.toContain("DEV_PID")
    // Must tell Claude not to try starting it
    expect(prompt).toMatch(/do not attempt|don't attempt/i)
  })

  it("falls back to prompt-based startup when engine did not manage server", () => {
    // No KODY_DEV_SERVER_READY env var — engine didn't manage the server
    delete process.env.KODY_DEV_SERVER_READY

    const prompt = buildFullPrompt("build", "test-task", taskDir, projectDir)

    // Should have prompt-based startup with nohup
    expect(prompt).toContain("nohup")
    expect(prompt).toContain("DEV_PID")
  })
})
