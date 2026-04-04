import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext, StageDefinition } from "../../src/types.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import { escalateModelTier } from "../../src/context.js"

vi.mock("../../src/github-api.js", () => ({
  setLifecycleLabel: vi.fn(),
  setLabel: vi.fn(),
  removeLabel: vi.fn(),
  postComment: vi.fn(),
  setGhCwd: vi.fn(),
  getIssueLabels: vi.fn(() => []),
}))

vi.mock("../../src/git-utils.js", () => ({
  ensureFeatureBranch: vi.fn(() => "42-test-branch"),
  syncWithDefault: vi.fn(),
  getCurrentBranch: vi.fn(() => "42-test-branch"),
  getDefaultBranch: vi.fn(() => "dev"),
  commitAll: vi.fn(() => ({ success: false, hash: "", message: "No changes" })),
  pushBranch: vi.fn(),
}))

describe("escalateModelTier", () => {
  it("escalates cheap → mid", () => {
    expect(escalateModelTier("cheap")).toBe("mid")
  })

  it("escalates mid → strong", () => {
    expect(escalateModelTier("mid")).toBe("strong")
  })

  it("keeps strong as strong (no further escalation)", () => {
    expect(escalateModelTier("strong")).toBe("strong")
  })

  it("returns strong for unknown tier", () => {
    expect(escalateModelTier("unknown")).toBe("strong")
  })
})

describe("model escalation on timeout", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-escalation-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
        agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeTaskDir(): string {
    const taskDir = path.join(tmpDir, ".kody/tasks", "escalation-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")
    return taskDir
  }

  it("escalates model tier on timeout and retries", async () => {
    const calls: { model: string; stageName: string }[] = []
    const runner: AgentRunner = {
      async run(stageName: string, _prompt: string, model: string): Promise<AgentResult> {
        calls.push({ model, stageName })
        // First call times out, second succeeds
        if (calls.length === 1) {
          return { outcome: "timed_out", error: "exit 143" }
        }
        return { outcome: "completed", output: "Done" }
      },
      async healthCheck() { return true },
    }

    const taskDir = makeTaskDir()
    const ctx: PipelineContext = {
      taskId: "escalation-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      sessions: {},
      input: { mode: "full" },
    }

    const { executeAgentStage } = await import("../../src/stages/agent.js")
    const def: StageDefinition = {
      name: "build",
      type: "agent",
      modelTier: "cheap",
      timeout: 60_000,
      maxRetries: 1,
    }

    const result = await executeAgentStage(ctx, def)
    expect(result.outcome).toBe("completed")
    expect(calls).toHaveLength(2)
    // First call uses cheap model, second uses mid model (escalated on timeout)
    expect(calls[0].model).toBe("test-model-cheap")
    expect(calls[1].model).toBe("test-model-mid")
  })

  it("does not escalate when stage succeeds", async () => {
    const calls: { model: string }[] = []
    const runner: AgentRunner = {
      async run(_stageName: string, _prompt: string, model: string): Promise<AgentResult> {
        calls.push({ model })
        return { outcome: "completed", output: "Done" }
      },
      async healthCheck() { return true },
    }

    const taskDir = makeTaskDir()
    const ctx: PipelineContext = {
      taskId: "escalation-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      sessions: {},
      input: { mode: "full" },
    }

    const { executeAgentStage } = await import("../../src/stages/agent.js")
    const def: StageDefinition = {
      name: "build",
      type: "agent",
      modelTier: "cheap",
      timeout: 60_000,
      maxRetries: 1,
    }

    const result = await executeAgentStage(ctx, def)
    expect(result.outcome).toBe("completed")
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe("test-model-cheap")
  })

  it("does not escalate on non-timeout failure (normal retry with same model)", async () => {
    const calls: { model: string }[] = []
    const runner: AgentRunner = {
      async run(_stageName: string, _prompt: string, model: string): Promise<AgentResult> {
        calls.push({ model })
        if (calls.length === 1) {
          return { outcome: "failed", error: "syntax error" }
        }
        return { outcome: "completed", output: "Done" }
      },
      async healthCheck() { return true },
    }

    const taskDir = makeTaskDir()
    const ctx: PipelineContext = {
      taskId: "escalation-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      sessions: {},
      input: { mode: "full" },
    }

    const { executeAgentStage } = await import("../../src/stages/agent.js")
    const def: StageDefinition = {
      name: "build",
      type: "agent",
      modelTier: "cheap",
      timeout: 60_000,
      maxRetries: 1,
    }

    const result = await executeAgentStage(ctx, def)
    expect(result.outcome).toBe("completed")
    expect(calls).toHaveLength(2)
    // Both calls use same model — no escalation for non-timeout
    expect(calls[0].model).toBe("test-model-cheap")
    expect(calls[1].model).toBe("test-model-cheap")
  })

  it("stays on strong tier when already at strongest", async () => {
    const calls: { model: string }[] = []
    const runner: AgentRunner = {
      async run(_stageName: string, _prompt: string, model: string): Promise<AgentResult> {
        calls.push({ model })
        if (calls.length === 1) {
          return { outcome: "timed_out", error: "exit 143" }
        }
        return { outcome: "completed", output: "Done" }
      },
      async healthCheck() { return true },
    }

    const taskDir = makeTaskDir()
    const ctx: PipelineContext = {
      taskId: "escalation-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      sessions: {},
      input: { mode: "full" },
    }

    const { executeAgentStage } = await import("../../src/stages/agent.js")
    const def: StageDefinition = {
      name: "build",
      type: "agent",
      modelTier: "strong",
      timeout: 60_000,
      maxRetries: 1,
    }

    const result = await executeAgentStage(ctx, def)
    expect(result.outcome).toBe("completed")
    expect(calls).toHaveLength(2)
    // Both calls use strong model — no further escalation
    expect(calls[0].model).toBe("test-model-strong")
    expect(calls[1].model).toBe("test-model-strong")
  })

  it("respects escalateOnTimeout: false config", async () => {
    // Reconfigure with escalateOnTimeout disabled
    resetProjectConfig()
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
        agent: { defaultRunner: "claude", escalateOnTimeout: false, modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
      }),
    )
    setConfigDir(tmpDir)

    const calls: { model: string }[] = []
    const runner: AgentRunner = {
      async run(_stageName: string, _prompt: string, model: string): Promise<AgentResult> {
        calls.push({ model })
        if (calls.length === 1) {
          return { outcome: "timed_out", error: "exit 143" }
        }
        return { outcome: "completed", output: "Done" }
      },
      async healthCheck() { return true },
    }

    const taskDir = makeTaskDir()
    const ctx: PipelineContext = {
      taskId: "escalation-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      sessions: {},
      input: { mode: "full" },
    }

    const { executeAgentStage } = await import("../../src/stages/agent.js")
    const def: StageDefinition = {
      name: "build",
      type: "agent",
      modelTier: "cheap",
      timeout: 60_000,
      maxRetries: 1,
    }

    const result = await executeAgentStage(ctx, def)
    expect(result.outcome).toBe("completed")
    expect(calls).toHaveLength(2)
    // Escalation disabled — both calls use same model
    expect(calls[0].model).toBe("test-model-cheap")
    expect(calls[1].model).toBe("test-model-cheap")
  })

  it("fails after exhausting all retries on timeout", async () => {
    const calls: { model: string }[] = []
    const runner: AgentRunner = {
      async run(_stageName: string, _prompt: string, model: string): Promise<AgentResult> {
        calls.push({ model })
        return { outcome: "timed_out", error: "exit 143" }
      },
      async healthCheck() { return true },
    }

    const taskDir = makeTaskDir()
    const ctx: PipelineContext = {
      taskId: "escalation-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      sessions: {},
      input: { mode: "full" },
    }

    const { executeAgentStage } = await import("../../src/stages/agent.js")
    const def: StageDefinition = {
      name: "build",
      type: "agent",
      modelTier: "cheap",
      timeout: 60_000,
      maxRetries: 1,
    }

    const result = await executeAgentStage(ctx, def)
    expect(result.outcome).toBe("timed_out")
    expect(calls).toHaveLength(2) // original + 1 retry
    // Should have escalated: cheap → mid
    expect(calls[0].model).toBe("test-model-cheap")
    expect(calls[1].model).toBe("test-model-mid")
  })
})
