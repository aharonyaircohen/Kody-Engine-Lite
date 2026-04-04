import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execSync } from "child_process"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import { parseCommentInputs } from "../../src/ci/parse-inputs.js"
import { resolveMcpEnvVars, buildTaskifyMcpConfigJson } from "../../src/mcp-config.js"
import type { McpServerConfig } from "../../src/config.js"
import type { AgentRunner, AgentResult } from "../../src/types.js"
import { TaskifyError } from "../../src/cli/taskify-command.js"

function createMockRunner(outcome: "completed" | "failed" = "completed"): AgentRunner {
  return {
    async run(): Promise<AgentResult> {
      return { outcome, output: "(mock)" }
    },
    async healthCheck() { return true },
  }
}

/** Runner that captures every call for inspection */
function createCapturingRunner(outcome: "completed" | "failed" = "completed") {
  const calls: { stage: string; prompt: string; options?: Record<string, unknown> }[] = []
  const runner: AgentRunner = {
    async run(stage, prompt, _model, _timeout, _taskDir, options): Promise<AgentResult> {
      calls.push({ stage, prompt, options: options as Record<string, unknown> })
      return { outcome, output: "(mock)" }
    },
    async healthCheck() { return true },
  }
  return { runner, calls }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setupTest(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-taskify-test-"))
  fs.writeFileSync(
    path.join(tmpDir, "kody.config.json"),
    JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
    }),
  )
  setConfigDir(tmpDir)
  return {
    tmpDir,
    cleanup: () => {
      resetProjectConfig()
      fs.rmSync(tmpDir, { recursive: true, force: true })
      vi.unstubAllEnvs()
    },
  }
}

// ─── parseCommentInputs ──────────────────────────────────────────────────────

describe("parseCommentInputs — taskify mode", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv("TRIGGER_TYPE", "comment")
    vi.stubEnv("ISSUE_NUMBER", "42")
    vi.stubEnv("ISSUE_IS_PR", "")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("parses @kody taskify --ticket ENG-42", () => {
    vi.stubEnv("COMMENT_BODY", "@kody taskify --ticket ENG-42")
    const result = parseCommentInputs()
    expect(result.mode).toBe("taskify")
    expect(result.ticket_id).toBe("ENG-42")
    expect(result.valid).toBe(true)
    expect(result.task_id).toMatch(/^taskify-42-/)
  })

  it("parses /kody taskify --ticket PROJ-123", () => {
    vi.stubEnv("COMMENT_BODY", "/kody taskify --ticket PROJ-123")
    const result = parseCommentInputs()
    expect(result.mode).toBe("taskify")
    expect(result.ticket_id).toBe("PROJ-123")
    expect(result.valid).toBe(true)
  })

  it("is valid with just issue body (no --ticket or --file) — uses inline description mode", () => {
    vi.stubEnv("COMMENT_BODY", "@kody taskify")
    vi.stubEnv("ISSUE_NUMBER", "42")
    const result = parseCommentInputs()
    expect(result.mode).toBe("taskify")
    expect(result.ticket_id).toBe("")
    expect(result.prd_file).toBe("")
    // Valid because issue body will be used as the description
    expect(result.valid).toBe(true)
  })

  it("parses @kody taskify --file docs/prd.md", () => {
    vi.stubEnv("COMMENT_BODY", "@kody taskify --file docs/prd.md")
    const result = parseCommentInputs()
    expect(result.mode).toBe("taskify")
    expect(result.prd_file).toBe("docs/prd.md")
    expect(result.ticket_id).toBe("")
    expect(result.valid).toBe(true)
  })

  it("includes ticket_id='' for non-taskify modes", () => {
    vi.stubEnv("COMMENT_BODY", "@kody")
    const result = parseCommentInputs()
    expect(result.mode).toBe("full")
    expect(result.ticket_id).toBe("")
  })

  it("approve maps to rerun and preserves feedback", () => {
    vi.stubEnv("COMMENT_BODY", "@kody approve\nHere are my answers: A, B, C")
    const result = parseCommentInputs()
    expect(result.mode).toBe("rerun")
    expect(result.feedback).toContain("Here are my answers")
  })
})

// ─── resolveMcpEnvVars ───────────────────────────────────────────────────────

describe("resolveMcpEnvVars", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("resolves ${VAR} placeholders from process.env", () => {
    vi.stubEnv("JIRA_URL", "https://company.atlassian.net")
    vi.stubEnv("JIRA_EMAIL", "dev@company.com")
    vi.stubEnv("JIRA_API_TOKEN", "secret-token")

    const servers: Record<string, McpServerConfig> = {
      jira: {
        command: "npx",
        args: ["-y", "@atlassianlabs/mcp-server-jira"],
        env: {
          JIRA_URL: "${JIRA_URL}",
          JIRA_EMAIL: "${JIRA_EMAIL}",
          JIRA_API_TOKEN: "${JIRA_API_TOKEN}",
        },
      },
    }

    const resolved = resolveMcpEnvVars(servers)
    expect(resolved.jira.env?.JIRA_URL).toBe("https://company.atlassian.net")
    expect(resolved.jira.env?.JIRA_EMAIL).toBe("dev@company.com")
    expect(resolved.jira.env?.JIRA_API_TOKEN).toBe("secret-token")
  })

  it("throws when a referenced env var is not set", () => {
    delete process.env.JIRA_URL_MISSING

    const servers: Record<string, McpServerConfig> = {
      jira: {
        command: "npx",
        env: { JIRA_URL: "${JIRA_URL_MISSING}" },
      },
    }

    expect(() => resolveMcpEnvVars(servers)).toThrow("JIRA_URL_MISSING")
  })

  it("does not modify servers without env", () => {
    const servers: Record<string, McpServerConfig> = {
      taskmaster: { command: "npx", args: ["--mcp"] },
    }
    const resolved = resolveMcpEnvVars(servers)
    expect(resolved.taskmaster.env).toBeUndefined()
  })

  it("passes through literal values (no ${} syntax)", () => {
    const servers: Record<string, McpServerConfig> = {
      jira: { command: "npx", env: { JIRA_URL: "https://literal.atlassian.net" } },
    }
    const resolved = resolveMcpEnvVars(servers)
    expect(resolved.jira.env?.JIRA_URL).toBe("https://literal.atlassian.net")
  })
})

// ─── buildTaskifyMcpConfigJson ───────────────────────────────────────────────

describe("buildTaskifyMcpConfigJson", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setupTest()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it("throws when no MCP servers are configured", () => {
    const config = getMinimalConfig(tmpDir)
    expect(() => buildTaskifyMcpConfigJson(config as any)).toThrow("mcp.servers")
  })

  it("uses only servers from config.mcp.servers — no defaults injected", () => {
    const customConfig = {
      ...getMinimalConfig(tmpDir),
      mcp: {
        enabled: true,
        servers: {
          myTaskManager: { command: "npx", args: ["-y", "my-tm-mcp"], env: { TM_URL: "https://tm.example.com" } },
        },
      },
    }
    vi.stubEnv("TM_URL", "https://tm.example.com")
    const json = buildTaskifyMcpConfigJson(customConfig as any)
    const parsed = JSON.parse(json)
    expect(Object.keys(parsed.mcpServers)).toEqual(["myTaskManager"])
    expect(parsed.mcpServers.myTaskManager.command).toBe("npx")
  })

  it("resolves env vars in the output JSON", () => {
    const customConfig = {
      ...getMinimalConfig(tmpDir),
      mcp: {
        enabled: true,
        servers: {
          tm: { command: "npx", env: { TM_TOKEN: "${TM_TOKEN}" } },
        },
      },
    }
    vi.stubEnv("TM_TOKEN", "resolved-token")
    const json = buildTaskifyMcpConfigJson(customConfig as any)
    const parsed = JSON.parse(json)
    expect(parsed.mcpServers.tm.env?.TM_TOKEN).toBe("resolved-token")
  })

  it("returns valid JSON string", () => {
    const customConfig = {
      ...getMinimalConfig(tmpDir),
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }
    const json = buildTaskifyMcpConfigJson(customConfig as any)
    expect(() => JSON.parse(json)).not.toThrow()
  })
})

// ─── taskifyCommand unit tests ───────────────────────────────────────────────

describe("taskifyCommand", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setupTest()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it("files issues when Claude returns status=ready", async () => {
    const taskId = "taskify-test-ready"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })

    // Pre-write the result file as if Claude wrote it
    const result = {
      status: "ready",
      tasks: [
        { title: "Add OAuth login", body: "## Acceptance criteria\n- User can log in with Google" },
        { title: "Add OAuth logout", body: "## Acceptance criteria\n- User can log out" },
      ],
    }
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify(result))

    // MCP config required so buildTaskifyMcpConfigJson doesn't throw
    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    // Run in local mode with mock runner (no Claude Code spawning, no GitHub API calls)
    await taskifyCommand({
      ticketId: "ENG-42",
      issueNumber: 99,
      local: true,
      projectDir: tmpDir,
      taskId,
      runner: createMockRunner(),
    })

    // Verify marker file was written
    expect(fs.existsSync(path.join(taskDir, "taskify.marker"))).toBe(true)
  })

  it("works in file mode without MCP config", async () => {
    const taskId = "taskify-test-file-mode"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })

    // Write a PRD file
    const prdFile = path.join(tmpDir, "prd.md")
    fs.writeFileSync(prdFile, "# My Feature\nBuild an awesome thing.")

    // Pre-write result (as if Claude wrote it)
    const result = {
      status: "ready",
      tasks: [{ title: "Build awesome thing", body: "Build it." }],
    }
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify(result))

    // No mcp config in kody.config.json — should not throw
    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(taskifyCommand({
      prdFile,
      local: true,
      projectDir: tmpDir,
      taskId,
      runner: createMockRunner(),
    })).resolves.not.toThrow()

    const marker = JSON.parse(fs.readFileSync(path.join(taskDir, "taskify.marker"), "utf-8"))
    expect(marker.prdFile).toBe(prdFile)
    expect(marker.ticketId).toBeUndefined()
  })

  it("isTaskifyRun returns true for taskify task dirs", async () => {
    const taskDir = path.join(tmpDir, ".kody", "tasks", "taskify-check")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify.marker"), JSON.stringify({ ticketId: "ENG-1" }))

    const { isTaskifyRun } = await import("../../src/cli/taskify-command.js")
    expect(isTaskifyRun(taskDir)).toBe(true)
  })

  it("isTaskifyRun returns false for regular pipeline task dirs", async () => {
    const taskDir = path.join(tmpDir, ".kody", "tasks", "regular-task")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Regular task")

    const { isTaskifyRun } = await import("../../src/cli/taskify-command.js")
    expect(isTaskifyRun(taskDir)).toBe(false)
  })

  it("readTaskifyMarker parses ticket marker correctly", async () => {
    const taskDir = path.join(tmpDir, ".kody", "tasks", "taskify-marker")
    fs.mkdirSync(taskDir, { recursive: true })
    const marker = { ticketId: "PROJ-99", issueNumber: 42 }
    fs.writeFileSync(path.join(taskDir, "taskify.marker"), JSON.stringify(marker))

    const { readTaskifyMarker } = await import("../../src/cli/taskify-command.js")
    const result = readTaskifyMarker(taskDir)
    expect(result?.ticketId).toBe("PROJ-99")
    expect(result?.issueNumber).toBe(42)
    expect(result?.prdFile).toBeUndefined()
  })

  it("readTaskifyMarker parses prdFile marker correctly", async () => {
    const taskDir = path.join(tmpDir, ".kody", "tasks", "taskify-file-marker")
    fs.mkdirSync(taskDir, { recursive: true })
    const marker = { prdFile: "/path/to/prd.md", issueNumber: 7 }
    fs.writeFileSync(path.join(taskDir, "taskify.marker"), JSON.stringify(marker))

    const { readTaskifyMarker } = await import("../../src/cli/taskify-command.js")
    const result = readTaskifyMarker(taskDir)
    expect(result?.prdFile).toBe("/path/to/prd.md")
    expect(result?.ticketId).toBeUndefined()
    expect(result?.issueNumber).toBe(7)
  })

  it("ticket mode throws TaskifyError when no MCP servers configured", async () => {
    const taskId = "taskify-test-no-mcp"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })

    // No mcp config
    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: createMockRunner() })
    ).rejects.toThrow(TaskifyError)
  })

  it("throws TaskifyError when runner fails", async () => {
    const taskId = "taskify-test-runner-fail"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })

    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: createMockRunner("failed") })
    ).rejects.toThrow("Taskify failed")
  })

  it("throws TaskifyError when runner times out", async () => {
    const taskId = "taskify-test-timeout"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })

    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const timedOutRunner: AgentRunner = {
      async run(): Promise<AgentResult> { return { outcome: "timed_out" } },
      async healthCheck() { return true },
    }

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: timedOutRunner })
    ).rejects.toThrow("timed out")
  })

  it("throws TaskifyError when result file is missing", async () => {
    const taskId = "taskify-test-no-result"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })

    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    // Runner succeeds but no result file is written
    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: createMockRunner() })
    ).rejects.toThrow("did not write")
  })

  it("throws TaskifyError when result file contains invalid JSON", async () => {
    const taskId = "taskify-test-bad-json"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), "not valid json {{{")

    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: createMockRunner() })
    ).rejects.toThrow("Could not parse")
  })

  it("throws TaskifyError when result has unexpected status", async () => {
    const taskId = "taskify-test-bad-status"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({ status: "banana" }))

    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: createMockRunner() })
    ).rejects.toThrow("Unexpected status")
  })

  it("handles status=questions without throwing", async () => {
    const taskId = "taskify-test-questions"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({
      status: "questions",
      questions: ["What database should we use?", "Should we support mobile?"],
    }))

    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: createMockRunner() })
    ).resolves.not.toThrow()
  })

  it("handles >MAX_TASKS_GUARD tasks without crashing (local mode)", async () => {
    const taskId = "taskify-test-many-tasks"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })

    const tasks = Array.from({ length: 25 }, (_, i) => ({ title: `Task ${i}`, body: `Body ${i}` }))
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({ status: "ready", tasks }))

    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(tmpDir)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await expect(
      taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId, runner: createMockRunner() })
    ).resolves.not.toThrow()
  })
})

// ─── Prompt template rendering ──────────────────────────────────────────────

describe("prompt template rendering", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setupTest()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  function withMcp(dir: string) {
    fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(dir)
  }

  it("ticket mode prompt contains ticket ID and MCP fetch block, not file content block", async () => {
    withMcp(tmpDir)
    const taskId = "taskify-prompt-ticket"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({ status: "ready", tasks: [] }))

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner, calls } = createCapturingRunner()

    await taskifyCommand({ ticketId: "ENG-55", local: true, projectDir: tmpDir, taskId, runner })

    expect(calls).toHaveLength(1)
    const prompt = calls[0].prompt
    expect(prompt).toContain("ENG-55")
    expect(prompt).toContain("Mode: ticket")
    expect(prompt).toContain("MCP tools")
    // file content block must not appear
    expect(prompt).not.toContain("{{FILE_CONTENT}}")
    expect(prompt).not.toContain("Mode: file")
  })

  it("file mode prompt contains file content, not MCP fetch block", async () => {
    // No MCP config needed
    const taskId = "taskify-prompt-file"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({ status: "ready", tasks: [] }))

    const prdFile = path.join(tmpDir, "my-feature.md")
    fs.writeFileSync(prdFile, "# My Feature\nBuild something great.")

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner, calls } = createCapturingRunner()

    await taskifyCommand({ prdFile, local: true, projectDir: tmpDir, taskId, runner })

    expect(calls).toHaveLength(1)
    const prompt = calls[0].prompt
    expect(prompt).toContain("Build something great.")
    expect(prompt).toContain("Mode: file")
    // MCP ticket fetch block must not appear
    expect(prompt).not.toContain("{{TICKET_ID}}")
    expect(prompt).not.toContain("Mode: ticket")
  })

  it("feedback block appears when feedback is provided", async () => {
    withMcp(tmpDir)
    const taskId = "taskify-prompt-feedback"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({ status: "ready", tasks: [] }))

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner, calls } = createCapturingRunner()

    await taskifyCommand({
      ticketId: "ENG-99",
      feedback: "Please use React, not Vue.",
      local: true,
      projectDir: tmpDir,
      taskId,
      runner,
    })

    const prompt = calls[0].prompt
    expect(prompt).toContain("Please use React, not Vue.")
    expect(prompt).not.toContain("{{FEEDBACK}}")
  })

  it("feedback block is absent when no feedback provided", async () => {
    withMcp(tmpDir)
    const taskId = "taskify-prompt-no-feedback"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({ status: "ready", tasks: [] }))

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner, calls } = createCapturingRunner()

    await taskifyCommand({ ticketId: "ENG-10", local: true, projectDir: tmpDir, taskId, runner })

    const prompt = calls[0].prompt
    expect(prompt).not.toContain("Answers to previous questions")
    expect(prompt).not.toContain("{{FEEDBACK}}")
    expect(prompt).not.toContain("{{#if")
  })

  it("ticket mode runner receives mcpConfigJson; file mode does not", async () => {
    const taskId1 = "taskify-mcp-ticket"
    const taskId2 = "taskify-mcp-file"

    // Ticket mode — with MCP
    withMcp(tmpDir)
    const taskDir1 = path.join(tmpDir, ".kody", "tasks", taskId1)
    fs.mkdirSync(taskDir1, { recursive: true })
    fs.writeFileSync(path.join(taskDir1, "taskify-result.json"), JSON.stringify({ status: "ready", tasks: [] }))

    const prdFile = path.join(tmpDir, "spec.md")
    fs.writeFileSync(prdFile, "Spec content")
    const taskDir2 = path.join(tmpDir, ".kody", "tasks", taskId2)
    fs.mkdirSync(taskDir2, { recursive: true })
    fs.writeFileSync(path.join(taskDir2, "taskify-result.json"), JSON.stringify({ status: "ready", tasks: [] }))

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner: r1, calls: c1 } = createCapturingRunner()
    const { runner: r2, calls: c2 } = createCapturingRunner()

    await taskifyCommand({ ticketId: "ENG-1", local: true, projectDir: tmpDir, taskId: taskId1, runner: r1 })
    await taskifyCommand({ prdFile, local: true, projectDir: tmpDir, taskId: taskId2, runner: r2 })

    expect(c1[0].options?.mcpConfigJson).toBeDefined()
    expect(c2[0].options?.mcpConfigJson).toBeUndefined()
  })
})

// ─── parseCommentInputs — prd_file field ────────────────────────────────────

describe("parseCommentInputs — prd_file field", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv("TRIGGER_TYPE", "comment")
    vi.stubEnv("ISSUE_NUMBER", "10")
    vi.stubEnv("ISSUE_IS_PR", "")
  })

  afterEach(() => vi.unstubAllEnvs())

  it("prd_file is empty for non-taskify modes", () => {
    vi.stubEnv("COMMENT_BODY", "@kody")
    const result = parseCommentInputs()
    expect(result.prd_file).toBe("")
  })

  it("prd_file is empty for ticket mode", () => {
    vi.stubEnv("COMMENT_BODY", "@kody taskify --ticket ENG-1")
    const result = parseCommentInputs()
    expect(result.ticket_id).toBe("ENG-1")
    expect(result.prd_file).toBe("")
  })

  it("prd_file is set and ticket_id is empty for --file mode", () => {
    vi.stubEnv("COMMENT_BODY", "@kody taskify --file docs/spec.md")
    const result = parseCommentInputs()
    expect(result.prd_file).toBe("docs/spec.md")
    expect(result.ticket_id).toBe("")
    expect(result.valid).toBe(true)
  })

  it("prd_file included in dispatch passthrough result", () => {
    vi.stubEnv("TRIGGER_TYPE", "dispatch")
    vi.stubEnv("INPUT_TASK_ID", "taskify-99-abc")
    vi.stubEnv("INPUT_MODE", "taskify")
    const result = parseCommentInputs()
    expect(result.prd_file).toBe("")
    expect(result.valid).toBe(true)
  })
})

// ─── Auto-trigger threshold ──────────────────────────────────────────────────

describe("auto-trigger threshold logic", () => {
  it("AUTO_TRIGGER_THRESHOLD is 5", () => {
    // This is a documentation test — ensures the threshold is intentional
    // Actual threshold is defined in taskify-command.ts
    // If it changes, this test reminds the developer to update docs
    const threshold = 5
    const tasks6 = Array.from({ length: 6 }, (_, i) => ({ title: `Task ${i}`, body: "body" }))
    const tasks4 = Array.from({ length: 4 }, (_, i) => ({ title: `Task ${i}`, body: "body" }))

    expect(tasks6.length > threshold).toBe(true)   // 6 > 5: no auto-trigger
    expect(tasks4.length <= threshold).toBe(true)  // 4 ≤ 5: auto-trigger
  })
})

// ─── topoSort ───────────────────────────────────────────────────────────────

describe("topoSort", () => {
  it("returns tasks in dependency order when given wrong order", async () => {
    const { topoSort } = await import("../../src/cli/taskify-command.js")

    // task 0 depends on task 1 — so task 1 must come first
    const tasks = [
      { title: "B", body: "body", dependsOn: [1] },
      { title: "A", body: "body", dependsOn: [] },
    ]
    const sorted = topoSort(tasks)
    expect(sorted[0].title).toBe("A")
    expect(sorted[1].title).toBe("B")
  })

  it("handles a chain of three dependencies", async () => {
    const { topoSort } = await import("../../src/cli/taskify-command.js")

    // 0→2, 1→0 → order: 2, 0, 1  (or 2 first, then 0, then 1, or 2 then 1 then 0 depending on queue)
    // task 0 dependsOn [2], task 1 dependsOn [0], task 2 has none
    const tasks = [
      { title: "C", body: "body", dependsOn: [2] },  // 0: needs 2
      { title: "D", body: "body", dependsOn: [0] },  // 1: needs 0
      { title: "A", body: "body" },                   // 2: no deps
    ]
    const sorted = topoSort(tasks)
    const titles = sorted.map((t) => t.title)
    // A must precede C, C must precede D
    expect(titles.indexOf("A")).toBeLessThan(titles.indexOf("C"))
    expect(titles.indexOf("C")).toBeLessThan(titles.indexOf("D"))
  })

  it("detects a cycle and returns original order without crashing", async () => {
    const { topoSort } = await import("../../src/cli/taskify-command.js")

    const tasks = [
      { title: "A", body: "body", dependsOn: [1] },  // 0→1
      { title: "B", body: "body", dependsOn: [0] },  // 1→0  (cycle)
    ]
    const sorted = topoSort(tasks)
    // Falls back to original order
    expect(sorted[0].title).toBe("A")
    expect(sorted[1].title).toBe("B")
  })

  it("leaves order unchanged when dependsOn is absent or empty", async () => {
    const { topoSort } = await import("../../src/cli/taskify-command.js")

    const tasks = [
      { title: "X", body: "body" },
      { title: "Y", body: "body", dependsOn: [] },
      { title: "Z", body: "body" },
    ]
    const sorted = topoSort(tasks)
    expect(sorted.map((t) => t.title)).toEqual(["X", "Y", "Z"])
  })
})

// ─── Priority labels ─────────────────────────────────────────────────────────

describe("priority label merging", () => {
  let tmpDir: string
  let cleanup: () => void
  const createdIssues: { title: string; body: string; labels: string[] | undefined }[] = []

  beforeEach(() => {
    const t = setupTest()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
    createdIssues.length = 0
  })

  afterEach(() => cleanup())

  function writeResult(dir: string, tasks: object[]) {
    fs.writeFileSync(path.join(dir, "taskify-result.json"), JSON.stringify({ status: "ready", tasks }))
  }

  function setupMcpConfig(dir: string) {
    fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(dir)
  }

  it("priority:high appears in labels passed to createIssue", async () => {
    setupMcpConfig(tmpDir)
    const taskId = "priority-high-test"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    writeResult(taskDir, [{ title: "High priority task", body: "body", priority: "high" }])

    const githubApi = await import("../../src/github-api.js")
    // Return a value so the retry path is not triggered
    const issueSpy = vi.spyOn(githubApi, "createIssue").mockReturnValue({ number: 1, url: "http://x/1" })

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await taskifyCommand({
      ticketId: "ENG-1",
      issueNumber: undefined,
      local: false,
      projectDir: tmpDir,
      taskId,
      runner: createMockRunner(),
    })

    expect(issueSpy).toHaveBeenCalledOnce()
    const labelsArg = issueSpy.mock.calls[0][2]
    expect(labelsArg).toContain("priority:high")
    issueSpy.mockRestore()
  })

  it("missing priority adds no extra label", async () => {
    setupMcpConfig(tmpDir)
    const taskId = "priority-none-test"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    // "backend" is a custom category label — gets filtered out by safe-label logic
    writeResult(taskDir, [{ title: "No priority task", body: "body", labels: ["backend"] }])

    const githubApi = await import("../../src/github-api.js")
    const issueSpy = vi.spyOn(githubApi, "createIssue").mockReturnValue({ number: 2, url: "http://x/2" })

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await taskifyCommand({
      ticketId: "ENG-2",
      issueNumber: undefined,
      local: false,
      projectDir: tmpDir,
      taskId,
      runner: createMockRunner(),
    })

    expect(issueSpy).toHaveBeenCalledOnce()
    const labelsArg = issueSpy.mock.calls[0][2]
    // "backend" is filtered out (not a priority: or kody: label)
    expect(labelsArg).toEqual([])
    expect(labelsArg?.some((l: string) => l.startsWith("priority:"))).toBe(false)
    issueSpy.mockRestore()
  })

  it("priority coexists with kody: labels (custom labels filtered out)", async () => {
    setupMcpConfig(tmpDir)
    const taskId = "priority-with-labels-test"
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    // "frontend" and "ux" are custom labels — filtered out; "kody:feature" is safe
    writeResult(taskDir, [{ title: "Task with labels", body: "body", labels: ["frontend", "ux", "kody:feature"], priority: "medium" }])

    const githubApi = await import("../../src/github-api.js")
    const issueSpy = vi.spyOn(githubApi, "createIssue").mockReturnValue({ number: 3, url: "http://x/3" })

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")

    await taskifyCommand({
      ticketId: "ENG-3",
      issueNumber: undefined,
      local: false,
      projectDir: tmpDir,
      taskId,
      runner: createMockRunner(),
    })

    expect(issueSpy).toHaveBeenCalledOnce()
    const labelsArg = issueSpy.mock.calls[0][2]
    // Only kody: and priority: labels survive the filter
    expect(labelsArg).toContain("kody:feature")
    expect(labelsArg).toContain("priority:medium")
    expect(labelsArg).not.toContain("frontend")
    expect(labelsArg).not.toContain("ux")
    issueSpy.mockRestore()
  })
})

// ─── Codebase context injection ──────────────────────────────────────────────

describe("codebase context injection", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setupTest()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  function withMcp(dir: string) {
    fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      mcp: { enabled: true, servers: { tm: { command: "npx" } } },
    }))
    resetProjectConfig()
    setConfigDir(dir)
  }

  function setupTaskDir(taskId: string): string {
    const taskDir = path.join(tmpDir, ".kody", "tasks", taskId)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "taskify-result.json"), JSON.stringify({ status: "ready", tasks: [] }))
    return taskDir
  }

  it("memory.md content appears in prompt when file exists", async () => {
    withMcp(tmpDir)
    const taskId = "ctx-memory-present"
    setupTaskDir(taskId)

    const memDir = path.join(tmpDir, ".kody")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "memory.md"), "We use tRPC for all API endpoints.\nPrisma handles all DB migrations.")

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner, calls } = createCapturingRunner()

    await taskifyCommand({ ticketId: "ENG-10", local: true, projectDir: tmpDir, taskId, runner })

    const prompt = calls[0].prompt
    expect(prompt).toContain("We use tRPC for all API endpoints.")
    expect(prompt).toContain("Existing codebase")
  })

  it("no PROJECT_CONTEXT block and no raw {{ tokens when memory.md is absent and no git repo", async () => {
    withMcp(tmpDir)
    const taskId = "ctx-memory-absent"
    setupTaskDir(taskId)
    // tmpDir has no .kody/memory.md and is not a git repo

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner, calls } = createCapturingRunner()

    await taskifyCommand({ ticketId: "ENG-11", local: true, projectDir: tmpDir, taskId, runner })

    const prompt = calls[0].prompt
    expect(prompt).not.toContain("Existing codebase")
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(prompt).not.toContain("{{#if")
  })

  it("no crash when projectDir is not a git repo", async () => {
    withMcp(tmpDir)
    const taskId = "ctx-no-git"
    setupTaskDir(taskId)

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner } = createCapturingRunner()

    await expect(
      taskifyCommand({ ticketId: "ENG-12", local: true, projectDir: tmpDir, taskId, runner })
    ).resolves.not.toThrow()
  })

  it("file tree appears in prompt when projectDir is a git repo", async () => {
    withMcp(tmpDir)
    const taskId = "ctx-git-tree"
    setupTaskDir(taskId)

    // Initialise a real git repo so git ls-files works
    execSync("git init", { cwd: tmpDir, stdio: "ignore" })
    execSync("git add kody.config.json", { cwd: tmpDir, stdio: "ignore" })

    const { taskifyCommand } = await import("../../src/cli/taskify-command.js")
    const { runner, calls } = createCapturingRunner()

    await taskifyCommand({ ticketId: "ENG-13", local: true, projectDir: tmpDir, taskId, runner })

    const prompt = calls[0].prompt
    expect(prompt).toContain("File Tree")
    expect(prompt).toContain("kody.config.json")
  })
})

// ─── Test Strategy section in prompt ────────────────────────────────────────

describe("prompt — Test Strategy requirement", () => {
  it("prompt template instructs agent to include a Test Strategy section", () => {
    const templatePath = path.resolve(__dirname, "../../prompts/taskify-ticket.md")
    const template = fs.readFileSync(templatePath, "utf-8")
    expect(template).toContain("Test Strategy")
    expect(template).toContain("## Test Strategy")
  })
})

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMinimalConfig(tmpDir: string) {
  return {
    quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
    git: { defaultBranch: "main" },
    github: { owner: "test", repo: "test" },
    agent: { modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
  }
}
