import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// Mock external dependencies
vi.mock("../../src/stages/agent.js", () => ({
  executeAgentStage: vi.fn().mockResolvedValue({ outcome: "completed", retries: 0 }),
}))

vi.mock("../../src/stages/decompose.js", () => ({
  executeDecompose: vi.fn(),
}))

vi.mock("../../src/pipeline/sub-pipeline.js", () => ({
  runSubPipelinesParallel: vi.fn(),
}))

vi.mock("../../src/git-utils.js", () => ({
  ensureFeatureBranch: vi.fn().mockReturnValue("42-test-feature"),
  getCurrentBranch: vi.fn().mockReturnValue("42-test-feature"),
  commitAll: vi.fn().mockReturnValue({ success: true, hash: "abc", message: "test" }),
}))

vi.mock("../../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktrees: vi.fn(),
  worktreePath: vi.fn().mockImplementation((_tid: string, sid: string) => `/tmp/kody-wt/${sid}`),
  getWorktreeChangedFiles: vi.fn().mockReturnValue([]),
}))

vi.mock("../../src/commands/compose.js", () => ({
  runCompose: vi.fn().mockResolvedValue({
    taskId: "test-task",
    state: "completed",
    decompose: { decomposable: true, reason: "test", complexity_score: 7, recommended_subtasks: 2, sub_tasks: [] },
    subPipelines: [],
    mergeOutcome: "merged",
    compose: { verify: "completed", review: "completed", ship: "completed" },
  }),
}))

vi.mock("../../src/pipeline.js", () => ({
  runPipeline: vi.fn().mockResolvedValue({
    taskId: "test-task",
    state: "completed",
    stages: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
}))

vi.mock("../../src/config.js", () => ({
  getProjectConfig: vi.fn().mockReturnValue({
    quality: {},
    git: { defaultBranch: "dev" },
    github: { owner: "test", repo: "test" },
    agent: { modelMap: { cheap: "claude/haiku", mid: "claude/sonnet", strong: "claude/opus" } },
    decompose: { enabled: true, maxParallelSubTasks: 3, minComplexityScore: 6 },
  }),
  resolveStageConfig: vi.fn().mockReturnValue({ provider: "claude", model: "haiku" }),
  stageNeedsProxy: vi.fn().mockReturnValue(false),
  getLitellmUrl: vi.fn().mockReturnValue("http://localhost:4000"),
  setConfigDir: vi.fn(),
  resetProjectConfig: vi.fn(),
}))

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { runDecompose } from "../../src/commands/decompose.js"
import { executeDecompose } from "../../src/stages/decompose.js"
import { runSubPipelinesParallel } from "../../src/pipeline/sub-pipeline.js"
import { runCompose } from "../../src/commands/compose.js"
import type { DecomposeOutput } from "../../src/types.js"

describe("runDecompose", () => {
  let tmpDir: string
  let taskDir: string

  const mockRunner = {
    run: vi.fn().mockResolvedValue({ outcome: "completed", output: "done" }),
    healthCheck: vi.fn().mockResolvedValue(true),
  }

  const baseOpts = {
    issueNumber: 42,
    projectDir: "", // set in beforeEach
    runners: { claude: mockRunner },
    taskId: "test-task",
    taskDir: "", // set in beforeEach
    local: true,
    autoCompose: true,
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-decompose-test-"))
    taskDir = path.join(tmpDir, ".kody", "tasks", "test-task")
    fs.mkdirSync(taskDir, { recursive: true })

    // Write task.md
    fs.writeFileSync(path.join(taskDir, "task.md"), "# Test Feature\n\nImplement test feature")

    baseOpts.projectDir = tmpDir
    baseOpts.taskDir = taskDir

    vi.clearAllMocks()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("falls back to pipeline when decompose returns not decomposable", async () => {
    // taskify will write task.json
    const { executeAgentStage } = await import("../../src/stages/agent.js")
    vi.mocked(executeAgentStage).mockImplementation(async (_ctx, def) => {
      if (def.name === "taskify") {
        fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
          task_type: "feature", title: "Test", description: "Test",
          scope: ["src/a.ts"], risk_level: "medium",
        }))
      }
      if (def.name === "plan") {
        fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: Do thing\nDetails")
      }
      return { outcome: "completed", retries: 0 }
    })

    vi.mocked(executeDecompose).mockResolvedValue({
      decomposable: false,
      reason: "Too simple",
      complexity_score: 3,
      recommended_subtasks: 1,
      sub_tasks: [],
    })

    const result = await runDecompose(baseOpts)
    expect(result.decompose.decomposable).toBe(false)
  })

  it("falls back when risk_level is low", async () => {
    const { executeAgentStage } = await import("../../src/stages/agent.js")
    vi.mocked(executeAgentStage).mockImplementation(async (_ctx, def) => {
      if (def.name === "taskify") {
        fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
          task_type: "chore", title: "Test", description: "Test",
          scope: ["src/a.ts"], risk_level: "low",
        }))
      }
      return { outcome: "completed", retries: 0 }
    })

    const result = await runDecompose(baseOpts)
    // Should have fallen back — decompose never called
    expect(executeDecompose).not.toHaveBeenCalled()
  })

  it("runs full decompose flow with auto-compose", async () => {
    const decomposable: DecomposeOutput = {
      decomposable: true,
      reason: "Two independent groups",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "API", description: "API work", scope: ["src/api.ts"], plan_steps: [1], depends_on: [], shared_context: "" },
        { id: "part-2", title: "UI", description: "UI work", scope: ["src/ui.tsx"], plan_steps: [2], depends_on: [], shared_context: "" },
      ],
    }

    const { executeAgentStage } = await import("../../src/stages/agent.js")
    vi.mocked(executeAgentStage).mockImplementation(async (_ctx, def) => {
      if (def.name === "taskify") {
        fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
          task_type: "feature", title: "Test", description: "Test",
          scope: ["src/api.ts", "src/ui.tsx"], risk_level: "high",
        }))
      }
      if (def.name === "plan") {
        fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: API\nAPI work\n## Step 2: UI\nUI work")
      }
      return { outcome: "completed", retries: 0 }
    })

    vi.mocked(executeDecompose).mockResolvedValue(decomposable)
    vi.mocked(runSubPipelinesParallel).mockResolvedValue([
      { subTaskId: "part-1", outcome: "completed", branchName: "42-test/part-1" },
      { subTaskId: "part-2", outcome: "completed", branchName: "42-test/part-2" },
    ])

    const result = await runDecompose(baseOpts)

    // Should have run compose
    expect(runCompose).toHaveBeenCalled()
    expect(result.state).toBe("completed")
  })

  it("falls back when sub-task fails", async () => {
    const { executeAgentStage } = await import("../../src/stages/agent.js")
    vi.mocked(executeAgentStage).mockImplementation(async (_ctx, def) => {
      if (def.name === "taskify") {
        fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
          task_type: "feature", title: "Test", description: "Test",
          scope: ["src/api.ts", "src/ui.tsx"], risk_level: "high",
        }))
      }
      if (def.name === "plan") {
        fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: Work\nDetails")
      }
      return { outcome: "completed", retries: 0 }
    })

    vi.mocked(executeDecompose).mockResolvedValue({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "A", description: "A", scope: ["a.ts"], plan_steps: [1], depends_on: [], shared_context: "" },
        { id: "part-2", title: "B", description: "B", scope: ["b.ts"], plan_steps: [2], depends_on: [], shared_context: "" },
      ],
    })

    vi.mocked(runSubPipelinesParallel).mockResolvedValue([
      { subTaskId: "part-1", outcome: "completed", branchName: "br1" },
      { subTaskId: "part-2", outcome: "failed", branchName: "", error: "Build error" },
    ])

    const result = await runDecompose(baseOpts)
    // Should have fallen back to pipeline
    expect(result.mergeOutcome).toBe("fallback")
  })

  it("skips auto-compose when noCompose is set", async () => {
    const { executeAgentStage } = await import("../../src/stages/agent.js")
    vi.mocked(executeAgentStage).mockImplementation(async (_ctx, def) => {
      if (def.name === "taskify") {
        fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
          task_type: "feature", title: "Test", description: "Test",
          scope: ["src/api.ts", "src/ui.tsx"], risk_level: "high",
        }))
      }
      if (def.name === "plan") {
        fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: Work\nDetails")
      }
      return { outcome: "completed", retries: 0 }
    })

    vi.mocked(executeDecompose).mockResolvedValue({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "A", description: "A", scope: ["a.ts"], plan_steps: [1], depends_on: [], shared_context: "" },
        { id: "part-2", title: "B", description: "B", scope: ["b.ts"], plan_steps: [2], depends_on: [], shared_context: "" },
      ],
    })

    vi.mocked(runSubPipelinesParallel).mockResolvedValue([
      { subTaskId: "part-1", outcome: "completed", branchName: "br1" },
      { subTaskId: "part-2", outcome: "completed", branchName: "br2" },
    ])

    const result = await runDecompose({ ...baseOpts, autoCompose: false })

    // Should NOT have called compose
    expect(runCompose).not.toHaveBeenCalled()
    expect(result.state).toBe("completed")

    // Should have saved decompose-state.json
    const stateFile = path.join(taskDir, "decompose-state.json")
    expect(fs.existsSync(stateFile)).toBe(true)
  })
})
