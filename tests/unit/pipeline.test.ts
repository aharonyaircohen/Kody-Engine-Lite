import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline, printStatus } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

vi.mock("../../src/github-api.js", () => ({
  setLifecycleLabel: vi.fn(),
  setLabel: vi.fn(),
  removeLabel: vi.fn(),
  postComment: vi.fn(),
  setGhCwd: vi.fn(),
  getIssueLabels: vi.fn(() => []),
}))

function createMockRunner(responses?: Record<string, AgentResult>): AgentRunner {
  return {
    async run(stageName: string): Promise<AgentResult> {
      if (responses?.[stageName]) return responses[stageName]
      // Default: return stage-appropriate output
      if (stageName === "taskify") {
        return {
          outcome: "completed",
          output: JSON.stringify({
            task_type: "feature",
            title: "Test task",
            description: "Test",
            scope: ["src/test.ts"],
            risk_level: "high",
          }),
        }
      }
      if (stageName === "plan") {
        return { outcome: "completed", output: "## Step 1: Do something\n**File:** src/test.ts" }
      }
      if (stageName === "review") {
        return { outcome: "completed", output: "## Verdict: PASS\n\nAll good." }
      }
      return { outcome: "completed", output: "Done" }
    },
    async healthCheck() {
      return true
    },
  }
}

function createTestContext(tmpDir: string, overrides?: Partial<PipelineContext>): PipelineContext {
  const taskDir = path.join(tmpDir, ".kody/tasks", "test-task")
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, "task.md"), "Test task description")

  return {
    taskId: "test-task",
    taskDir,
    projectDir: tmpDir,
    runners: { claude: createMockRunner() },
    input: {
      mode: "full",
      dryRun: true, // dry-run to avoid real agent calls
    },
    ...overrides,
  }
}

describe("state-machine", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-sm-test-"))
    // Create minimal kody.config.json
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
        agent: { defaultRunner: "claude" },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates status.json on pipeline start", async () => {
    const ctx = createTestContext(tmpDir)
    await runPipeline(ctx)
    const statusPath = path.join(ctx.taskDir, "status.json")
    expect(fs.existsSync(statusPath)).toBe(true)
  })

  it("marks all stages completed in dry-run", async () => {
    const ctx = createTestContext(tmpDir)
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    for (const stage of Object.values(state.stages)) {
      expect(stage.state).toBe("completed")
    }
  })

  it("status.json has correct taskId", async () => {
    const ctx = createTestContext(tmpDir)
    await runPipeline(ctx)
    const status = JSON.parse(fs.readFileSync(path.join(ctx.taskDir, "status.json"), "utf-8"))
    expect(status.taskId).toBe("test-task")
  })

  it("resumes from fromStage", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "rerun", fromStage: "review", dryRun: true },
    })
    // Pre-populate earlier stages as completed
    const statusPath = path.join(ctx.taskDir, "status.json")
    const initialState = {
      taskId: "test-task",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0 },
        plan: { state: "completed", retries: 0 },
        build: { state: "completed", retries: 0 },
        verify: { state: "completed", retries: 0 },
        review: { state: "failed", retries: 0, error: "test" },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(statusPath, JSON.stringify(initialState))

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    // Earlier stages should still be completed
    expect(state.stages.taskify.state).toBe("completed")
    expect(state.stages.plan.state).toBe("completed")
  })

  it("printStatus doesn't throw for missing task", () => {
    expect(() => printStatus("nonexistent", path.join(tmpDir, "nope"))).not.toThrow()
  })
})

describe("complexity detection ordering", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-order-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
        agent: { defaultRunner: "claude" },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("detects HIGH complexity even when taskify has questions", async () => {
    // Taskify returns HIGH risk + questions — complexity should still be read
    const runner: AgentRunner = {
      async run(stageName: string): Promise<AgentResult> {
        if (stageName === "taskify") {
          return {
            outcome: "completed",
            output: JSON.stringify({
              task_type: "feature",
              title: "Auth rewrite",
              description: "Rewrite auth middleware",
              scope: ["src/auth.ts"],
              risk_level: "high",
              questions: ["Should we support OAuth2?"],
            }),
          }
        }
        return { outcome: "completed", output: "Done" }
      },
      async healthCheck() { return true },
    }

    const taskDir = path.join(tmpDir, ".kody/tasks", "order-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Auth rewrite task")

    const ctx: PipelineContext = {
      taskId: "order-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", local: false, issueNumber: 99 },
    }

    const state = await runPipeline(ctx)

    // Pipeline should pause for questions
    expect(state.state).toBe("failed")
    expect(state.stages.taskify.error).toContain("paused")

    // But complexity label should have been set before the pause
    // Verify task.json was written with risk_level (complexity was read)
    const taskJson = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"))
    expect(taskJson.risk_level).toBe("high")
  })
})

describe("complexity filtering", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-complexity-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
        agent: { defaultRunner: "claude" },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("low complexity skips plan, review, review-fix", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "full", dryRun: true, complexity: "low" },
    })
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    // Skipped stages should still be marked completed
    expect(state.stages.plan.state).toBe("completed")
    expect(state.stages.review.state).toBe("completed")
    expect(state.stages["review-fix"].state).toBe("completed")
  })

  it("medium complexity skips review-fix", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "full", dryRun: true, complexity: "medium" },
    })
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    expect(state.stages["review-fix"].state).toBe("completed")
  })

  it("high complexity runs all stages", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "full", dryRun: true, complexity: "high" },
    })
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
  })
})
