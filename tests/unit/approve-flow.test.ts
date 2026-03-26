import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/state-machine.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createRunner(taskifyQuestions: string[] = []): AgentRunner {
  return {
    async run(stageName: string): Promise<AgentResult> {
      if (stageName === "taskify") {
        return {
          outcome: "completed",
          output: JSON.stringify({
            task_type: "feature",
            title: "Test",
            description: "Test task",
            scope: ["src/test.ts"],
            risk_level: "high",
            questions: taskifyQuestions,
          }),
        }
      }
      if (stageName === "plan") {
        return {
          outcome: "completed",
          output: "## Step 1: Implement\n**File:** src/test.ts\n**Change:** Add code\n**Why:** Needed\n**Verify:** test",
        }
      }
      if (stageName === "review") {
        return { outcome: "completed", output: "## Verdict: PASS\nAll good." }
      }
      return { outcome: "completed", output: "Done" }
    },
    async healthCheck() { return true },
  }
}

function setup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-approve-test-"))
  fs.writeFileSync(
    path.join(tmpDir, "kody.config.json"),
    JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", format: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude" },
    }),
  )
  setConfigDir(tmpDir)
  return {
    tmpDir,
    cleanup: () => {
      resetProjectConfig()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

function createCtx(
  tmpDir: string,
  runner: AgentRunner,
  inputOverrides?: Partial<PipelineContext["input"]>,
): PipelineContext {
  const taskDir = path.join(tmpDir, ".tasks", "approve-test")
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, "task.md"), "Test task for approve flow")
  return {
    taskId: "approve-test",
    taskDir,
    projectDir: tmpDir,
    runners: { claude: runner },
    input: { mode: "full", local: true, ...inputOverrides },
  }
}

describe("approve flow: question pause", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("pipeline pauses when taskify returns questions (non-local with issue)", async () => {
    const runner = createRunner(["Should search be case-sensitive?", "Which users?"])
    const ctx = createCtx(tmpDir, runner, {
      local: false,
      issueNumber: 99,
    })

    const state = await runPipeline(ctx)

    // Pipeline should be "failed" (paused)
    expect(state.state).toBe("failed")
    // Taskify completed but with paused error
    expect(state.stages.taskify.state).toBe("completed")
    expect(state.stages.taskify.error).toContain("paused")
    // Plan should still be pending (not executed)
    expect(state.stages.plan.state).toBe("pending")
  })

  it("pipeline continues when taskify has no questions", async () => {
    const runner = createRunner([])
    const ctx = createCtx(tmpDir, runner, { dryRun: true })

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
  })

  it("pipeline continues in local mode even with questions", async () => {
    const runner = createRunner(["Some question?"])
    const ctx = createCtx(tmpDir, runner, { local: true, dryRun: true })

    // Local mode: questions are not checked (no issue to post on)
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
  })
})

describe("approve flow: resume from paused state", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("rerun resumes from plan when taskify was paused", async () => {
    const taskDir = path.join(tmpDir, ".tasks", "resume-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")

    // Simulate paused state after taskify
    const pausedStatus = {
      taskId: "resume-test",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0, error: "paused: waiting for answers" },
        plan: { state: "pending", retries: 0 },
        build: { state: "pending", retries: 0 },
        verify: { state: "pending", retries: 0 },
        review: { state: "pending", retries: 0 },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify(pausedStatus))

    // Also need task.json from previous taskify run
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({
        task_type: "feature",
        title: "Resume test",
        description: "Test",
        scope: ["src/test.ts"],
        risk_level: "high",
        questions: ["Q1?"],
      }),
    )

    const runner = createRunner()
    const ctx: PipelineContext = {
      taskId: "resume-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: {
        mode: "rerun",
        fromStage: "plan",
        feedback: "1. Yes, case-sensitive",
        dryRun: true,
      },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    // Taskify should remain completed from previous run
    expect(state.stages.taskify.state).toBe("completed")
  })

  it("feedback is available in context after approve", async () => {
    const taskDir = path.join(tmpDir, ".tasks", "feedback-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")

    let capturedPrompt = ""
    const capturingRunner: AgentRunner = {
      async run(_stageName: string, prompt: string): Promise<AgentResult> {
        capturedPrompt = prompt
        return { outcome: "completed", output: "## Step 1: X\n**File:** a.ts\n**Change:** Y\n**Why:** Z\n**Verify:** test" }
      },
      async healthCheck() { return true },
    }

    const pausedStatus = {
      taskId: "feedback-test",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0, error: "paused: waiting for answers" },
        plan: { state: "pending", retries: 0 },
        build: { state: "pending", retries: 0 },
        verify: { state: "pending", retries: 0 },
        review: { state: "pending", retries: 0 },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify(pausedStatus))

    const ctx: PipelineContext = {
      taskId: "feedback-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: capturingRunner },
      input: {
        mode: "rerun",
        fromStage: "plan",
        feedback: "1. Yes case-sensitive\n2. Admin users only",
      },
    }

    await runPipeline(ctx)

    // The plan stage prompt should contain the feedback
    expect(capturedPrompt).toContain("Human Feedback")
    expect(capturedPrompt).toContain("case-sensitive")
    expect(capturedPrompt).toContain("Admin users")
  })
})

describe("approve flow: auto-detect fromStage", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("finds next stage after paused taskify", () => {
    const taskDir = path.join(tmpDir, ".tasks", "autodetect-test")
    fs.mkdirSync(taskDir, { recursive: true })

    const pausedStatus = {
      taskId: "autodetect-test",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0, error: "paused: waiting for answers" },
        plan: { state: "pending", retries: 0 },
        build: { state: "pending", retries: 0 },
        verify: { state: "pending", retries: 0 },
        review: { state: "pending", retries: 0 },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify(pausedStatus))

    // Parse the status.json to find the resume stage (same logic as entry.ts)
    const status = JSON.parse(fs.readFileSync(path.join(taskDir, "status.json"), "utf-8"))
    const stageNames = ["taskify", "plan", "build", "verify", "review", "review-fix", "ship"]
    let fromStage: string | undefined

    for (const name of stageNames) {
      const s = status.stages[name]
      if (s?.error?.includes("paused")) {
        const idx = stageNames.indexOf(name)
        if (idx < stageNames.length - 1) {
          fromStage = stageNames[idx + 1]
          break
        }
      }
    }

    expect(fromStage).toBe("plan")
  })

  it("finds next stage after paused plan", () => {
    const taskDir = path.join(tmpDir, ".tasks", "autodetect-plan")
    fs.mkdirSync(taskDir, { recursive: true })

    const pausedStatus = {
      taskId: "autodetect-plan",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0 },
        plan: { state: "completed", retries: 0, error: "paused: waiting for answers" },
        build: { state: "pending", retries: 0 },
        verify: { state: "pending", retries: 0 },
        review: { state: "pending", retries: 0 },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify(pausedStatus))

    const status = JSON.parse(fs.readFileSync(path.join(taskDir, "status.json"), "utf-8"))
    const stageNames = ["taskify", "plan", "build", "verify", "review", "review-fix", "ship"]
    let fromStage: string | undefined

    for (const name of stageNames) {
      const s = status.stages[name]
      if (s?.error?.includes("paused")) {
        const idx = stageNames.indexOf(name)
        if (idx < stageNames.length - 1) {
          fromStage = stageNames[idx + 1]
          break
        }
      }
    }

    expect(fromStage).toBe("build")
  })

  it("finds failed stage when no paused state", () => {
    const taskDir = path.join(tmpDir, ".tasks", "autodetect-failed")
    fs.mkdirSync(taskDir, { recursive: true })

    const failedStatus = {
      taskId: "autodetect-failed",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0 },
        plan: { state: "completed", retries: 0 },
        build: { state: "failed", retries: 0, error: "timeout" },
        verify: { state: "pending", retries: 0 },
        review: { state: "pending", retries: 0 },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify(failedStatus))

    const status = JSON.parse(fs.readFileSync(path.join(taskDir, "status.json"), "utf-8"))
    const stageNames = ["taskify", "plan", "build", "verify", "review", "review-fix", "ship"]
    let fromStage: string | undefined

    for (const name of stageNames) {
      const s = status.stages[name]
      if (s?.error?.includes("paused")) {
        const idx = stageNames.indexOf(name)
        if (idx < stageNames.length - 1) {
          fromStage = stageNames[idx + 1]
          break
        }
      }
      if (s?.state === "failed" || s?.state === "pending") {
        fromStage = name
        break
      }
    }

    expect(fromStage).toBe("build")
  })
})

describe("paused state detection", () => {
  it("detects paused state from stages with 'paused' error", () => {
    const stages = {
      taskify: { state: "completed", retries: 0, error: "paused: waiting for answers" },
      plan: { state: "pending", retries: 0 },
      build: { state: "pending", retries: 0 },
      verify: { state: "pending", retries: 0 },
      review: { state: "pending", retries: 0 },
      "review-fix": { state: "pending", retries: 0 },
      ship: { state: "pending", retries: 0 },
    }

    const isPaused = Object.values(stages).some(
      (s) => typeof s === "object" && s !== null && "error" in s && typeof s.error === "string" && s.error.includes("paused"),
    )
    expect(isPaused).toBe(true)
  })

  it("does not detect paused when no paused error exists", () => {
    const stages = {
      taskify: { state: "completed", retries: 0 },
      plan: { state: "failed", retries: 0, error: "Model unavailable" },
      build: { state: "pending", retries: 0 },
      verify: { state: "pending", retries: 0 },
      review: { state: "pending", retries: 0 },
      "review-fix": { state: "pending", retries: 0 },
      ship: { state: "pending", retries: 0 },
    }

    const isPaused = Object.values(stages).some(
      (s) => typeof s === "object" && s !== null && "error" in s && typeof s.error === "string" && s.error.includes("paused"),
    )
    expect(isPaused).toBe(false)
  })

  it("paused pipeline has state=failed but is not a real failure", async () => {
    const { tmpDir, cleanup } = setup()
    try {
      const runner = createRunner(["Q1?"])
      const ctx = createCtx(tmpDir, runner, {
        local: false,
        issueNumber: 99,
      })

      const state = await runPipeline(ctx)

      // State is "failed" (that's how pause is tracked)
      expect(state.state).toBe("failed")

      // But it's actually paused — detectable by "paused" in error
      const isPaused = Object.values(state.stages).some(
        (s) => s.error?.includes("paused"),
      )
      expect(isPaused).toBe(true)

      // No stage has state "failed" — taskify is "completed" with paused error
      const hasRealFailure = Object.values(state.stages).some(
        (s) => s.state === "failed",
      )
      expect(hasRealFailure).toBe(false)
    } finally {
      cleanup()
    }
  })
})

describe("workflow parse: approve → rerun conversion", () => {
  it("approve comment body becomes feedback", () => {
    // Simulate the workflow parse logic
    const commentBody = `@kody approve

1. Yes, case-sensitive
2. Only admin users
3. No offline support needed`

    // Extract feedback (everything after @kody approve line)
    const approveBody = commentBody.split(/\n/).slice(1).join("\n").trim()

    expect(approveBody).toContain("case-sensitive")
    expect(approveBody).toContain("admin users")
    expect(approveBody).toContain("offline support")
  })

  it("approve with task-id extracts both", () => {
    const commentBody = `@kody approve 9-260326-072200

1. Yes to all`

    const kodyArgs = commentBody.match(/(?:@kody|\/kody)\s+(.*)/)?.[1] ?? ""
    const parts = kodyArgs.trim().split(/\s+/)
    const mode = parts[0] // "approve"
    const taskId = parts[1] // "9-260326-072200"

    expect(mode).toBe("approve")
    expect(taskId).toBe("9-260326-072200")
  })

  it("approve without task-id still works", () => {
    const commentBody = `@kody approve

Answers here`

    const kodyArgs = commentBody.match(/(?:@kody|\/kody)\s+(.*)/)?.[1] ?? ""
    const parts = kodyArgs.trim().split(/\s+/)
    const mode = parts[0]
    const taskId = parts[1] // undefined or part of answer

    expect(mode).toBe("approve")
    // taskId might capture first word of answer — workflow handles this
  })
})
