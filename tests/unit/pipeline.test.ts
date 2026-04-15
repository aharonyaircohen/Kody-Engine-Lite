import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline, printStatus } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import * as gitUtils from "../../src/git-utils.js"

// ─── Lock tests ─────────────────────────────────────────────────────────────

describe("pipeline lock", () => {
  let taskDir: string

  beforeEach(() => {
    taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-lock-test-"))
  })

  afterEach(() => {
    fs.rmSync(taskDir, { recursive: true, force: true })
  })

  it("acquireLock creates a lock file with the current PID", async () => {
    const { acquireLock, releaseLock } = await import("../../src/pipeline.js")
    acquireLock(taskDir)
    const lockPath = path.join(taskDir, ".lock")
    expect(fs.existsSync(lockPath)).toBe(true)
    const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10)
    expect(pid).toBe(process.pid)
    releaseLock(taskDir)
  })

  it("releaseLock removes the lock file", async () => {
    const { acquireLock, releaseLock } = await import("../../src/pipeline.js")
    acquireLock(taskDir)
    releaseLock(taskDir)
    expect(fs.existsSync(path.join(taskDir, ".lock"))).toBe(false)
  })

  it("acquireLock removes stale lock when PID is not alive", async () => {
    const { acquireLock, releaseLock } = await import("../../src/pipeline.js")
    const lockPath = path.join(taskDir, ".lock")
    fs.writeFileSync(lockPath, "999999")
    acquireLock(taskDir)
    const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10)
    expect(pid).toBe(process.pid)
    releaseLock(taskDir)
  })

  it("acquireLock throws when lock is held by another process", async () => {
    const { acquireLock } = await import("../../src/pipeline.js")
    const lockPath = path.join(taskDir, ".lock")
    fs.writeFileSync(lockPath, String(process.pid))
    expect(() => acquireLock(taskDir)).toThrow("Pipeline already running")
  })

  it("acquireLock overwrites corrupt lock (non-numeric PID)", async () => {
    const { acquireLock, releaseLock } = await import("../../src/pipeline.js")
    const lockPath = path.join(taskDir, ".lock")
    fs.writeFileSync(lockPath, "not-a-number")
    acquireLock(taskDir)
    const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10)
    expect(pid).toBe(process.pid)
    releaseLock(taskDir)
  })
})

describe("pipeline state", () => {
  let taskDir: string

  beforeEach(() => {
    taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-state-test-"))
  })

  afterEach(() => {
    fs.rmSync(taskDir, { recursive: true, force: true })
  })

  it("initState creates a running state with all stages pending", async () => {
    const { initState } = await import("../../src/pipeline/state.js")
    const state = initState("test-task-001")
    expect(state.taskId).toBe("test-task-001")
    expect(state.state).toBe("running")
    expect(Object.keys(state.stages).length).toBeGreaterThan(0)
    for (const s of Object.values(state.stages)) {
      expect(s.state).toBe("pending")
    }
  })

  it("writeState and loadState round-trip correctly", async () => {
    const { initState, writeState, loadState } = await import("../../src/pipeline/state.js")
    const state = initState("round-trip-test")
    const updated = writeState(state, taskDir)
    const loaded = loadState("round-trip-test", taskDir)
    expect(loaded).not.toBeNull()
    expect(loaded!.taskId).toBe("round-trip-test")
    expect(loaded!.state).toBe("running")
  })

  it("loadState returns null for unknown task", async () => {
    const { loadState } = await import("../../src/pipeline/state.js")
    expect(loadState("nonexistent", taskDir)).toBeNull()
  })

  it("loadState returns null for corrupt JSON", async () => {
    const { loadState } = await import("../../src/pipeline/state.js")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "status.json"), "not valid json{{{")
    expect(loadState("any-task", taskDir)).toBeNull()
  })
})


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
        agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
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
        agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
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
    expect(state.state).toBe("paused")
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
        agent: { defaultRunner: "claude", modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } },
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

describe("default branch sync", () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-sync-test-"))
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

  it("syncs with default branch (no override) on issue-based full run", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "full", issueNumber: 42 },
    })
    await runPipeline(ctx)
    // Issue-based: calls syncWithDefault(projectDir) with no branch override
    expect(gitUtils.syncWithDefault).toHaveBeenCalledWith(expect.any(String))
  })

  it("syncs with default branch (no override) on PR-based fix without prBaseBranch", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "rerun", prNumber: 10, fromStage: "build" },
    })
    await runPipeline(ctx)
    // No prBaseBranch provided — falls back to config default
    expect(gitUtils.syncWithDefault).toHaveBeenCalledWith(expect.any(String), undefined)
  })

  it("passes PR base branch to syncWithDefault on PR-based fix", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "rerun", prNumber: 10, prBaseBranch: "dev", fromStage: "build" },
    })
    await runPipeline(ctx)
    expect(gitUtils.syncWithDefault).toHaveBeenCalledWith(expect.any(String), "dev")
  })

  it("passes undefined to syncWithDefault when prBaseBranch not set", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "rerun", prNumber: 10, fromStage: "build" },
    })
    await runPipeline(ctx)
    expect(gitUtils.syncWithDefault).toHaveBeenCalledWith(expect.any(String), undefined)
  })

  it("passes PR base branch on PR-based rerun with prBaseBranch", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "rerun", prNumber: 10, issueNumber: 42, prBaseBranch: "main", fromStage: "build" },
    })
    await runPipeline(ctx)
    expect(gitUtils.syncWithDefault).toHaveBeenCalledWith(expect.any(String), "main")
  })

  it("does NOT create a feature branch on PR-based fix (already on PR branch)", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "rerun", prNumber: 10, fromStage: "build" },
    })
    await runPipeline(ctx)
    expect(gitUtils.ensureFeatureBranch).not.toHaveBeenCalled()
  })

  it("skips sync in dry-run", async () => {
    const ctx = createTestContext(tmpDir, {
      input: { mode: "full", dryRun: true },
    })
    await runPipeline(ctx)
    expect(gitUtils.syncWithDefault).not.toHaveBeenCalled()
  })
})
