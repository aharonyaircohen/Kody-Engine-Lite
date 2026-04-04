import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { PipelineContext, SubTaskDefinition } from "../../src/types.js"

// Mock executeAgentStage and commitAll before importing
vi.mock("../../src/stages/agent.js", () => ({
  executeAgentStage: vi.fn().mockResolvedValue({ outcome: "completed", retries: 0 }),
}))

vi.mock("../../src/git-utils.js", () => ({
  commitAll: vi.fn().mockReturnValue({ success: true, hash: "abc1234", message: "test" }),
}))

import { runSubPipeline } from "../../src/pipeline/sub-pipeline.js"

describe("runSubPipeline", () => {
  let tmpDir: string
  let taskDir: string
  let worktreeDir: string

  const mockRunner = {
    run: vi.fn().mockResolvedValue({ outcome: "completed", output: "done" }),
    healthCheck: vi.fn().mockResolvedValue(true),
  }

  const parentCtx: PipelineContext = {
    taskId: "test-task",
    taskDir: "", // set in beforeEach
    projectDir: "", // set in beforeEach
    runners: { claude: mockRunner },
    sessions: {},
    input: { mode: "full", local: true },
  }

  const subTask: SubTaskDefinition = {
    id: "part-1",
    title: "API endpoints",
    description: "Implement REST API",
    scope: ["src/api/endpoint.ts", "src/api/types.ts"],
    plan_steps: [1, 2],
    depends_on: [],
    shared_context: "Uses shared types from part-2",
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-subpipe-test-"))
    taskDir = path.join(tmpDir, "task")
    worktreeDir = path.join(tmpDir, "worktree")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.mkdirSync(worktreeDir, { recursive: true })

    // Write parent task.json
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      task_type: "feature",
      title: "Parent task",
      description: "Parent description",
      scope: ["src/api/endpoint.ts", "src/api/types.ts", "src/components/Form.tsx"],
      risk_level: "medium",
    }))

    parentCtx.taskDir = taskDir
    parentCtx.projectDir = worktreeDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it("creates sub-task directory with task artifacts", async () => {
    const fullPlan = "## Step 1: Add endpoint\nDetails\n## Step 2: Add types\nMore details\n## Step 3: UI\nUI stuff"

    await runSubPipeline(parentCtx, subTask, fullPlan, worktreeDir)

    const subTaskDir = path.join(taskDir, "subtasks", "part-1")
    expect(fs.existsSync(subTaskDir)).toBe(true)
    expect(fs.existsSync(path.join(subTaskDir, "task.md"))).toBe(true)
    expect(fs.existsSync(path.join(subTaskDir, "task.json"))).toBe(true)
    expect(fs.existsSync(path.join(subTaskDir, "plan.md"))).toBe(true)
    expect(fs.existsSync(path.join(subTaskDir, "constraints.json"))).toBe(true)
  })

  it("writes correct task.md with title and description", async () => {
    await runSubPipeline(parentCtx, subTask, "", worktreeDir)

    const taskMd = fs.readFileSync(path.join(taskDir, "subtasks", "part-1", "task.md"), "utf-8")
    expect(taskMd).toContain("# API endpoints")
    expect(taskMd).toContain("Implement REST API")
    expect(taskMd).toContain("Uses shared types from part-2")
  })

  it("writes constraints.json with allowed files", async () => {
    await runSubPipeline(parentCtx, subTask, "", worktreeDir)

    const constraints = JSON.parse(
      fs.readFileSync(path.join(taskDir, "subtasks", "part-1", "constraints.json"), "utf-8"),
    )
    expect(constraints.allowedFiles).toEqual(["src/api/endpoint.ts", "src/api/types.ts"])
  })

  it("inherits parent task classification", async () => {
    await runSubPipeline(parentCtx, subTask, "", worktreeDir)

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "subtasks", "part-1", "task.json"), "utf-8"),
    )
    expect(taskJson.task_type).toBe("feature")
    expect(taskJson.risk_level).toBe("medium")
    expect(taskJson.scope).toEqual(["src/api/endpoint.ts", "src/api/types.ts"])
  })

  it("returns completed result on success", async () => {
    const result = await runSubPipeline(parentCtx, subTask, "", worktreeDir)
    expect(result.outcome).toBe("completed")
    expect(result.subTaskId).toBe("part-1")
  })

  it("returns failed result when build fails", async () => {
    const { executeAgentStage } = await import("../../src/stages/agent.js")
    vi.mocked(executeAgentStage).mockResolvedValueOnce({
      outcome: "failed",
      error: "Build error",
      retries: 0,
    })

    const result = await runSubPipeline(parentCtx, subTask, "", worktreeDir)
    expect(result.outcome).toBe("failed")
    expect(result.error).toBeTruthy()
  })
})
