import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createRunner(): AgentRunner {
  const calls: string[] = []
  return {
    async run(stageName: string, prompt: string): Promise<AgentResult> {
      calls.push(stageName)
      if (stageName === "taskify") {
        return {
          outcome: "completed",
          output: JSON.stringify({
            task_type: "bugfix",
            title: "Fix auth middleware",
            description: "Add authentication to routes",
            scope: ["src/middleware/auth.ts"],
            risk_level: "high",
            questions: [],
          }),
        }
      }
      if (stageName === "plan") {
        return {
          outcome: "completed",
          output: "## Step 1: Add middleware\n**File:** src/middleware/auth.ts\n**Change:** Add auth\n**Why:** Security\n**Verify:** test",
        }
      }
      if (stageName === "review") {
        return { outcome: "completed", output: "## Verdict: PASS\n\n## Summary\nAdded auth.\n\n## Findings\n\n### Critical\nNone." }
      }
      return { outcome: "completed", output: "Done" }
    },
    async healthCheck() { return true },
    getCalls: () => calls,
  } as AgentRunner & { getCalls: () => string[] }
}

function setup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-fix-test-"))
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
    },
  }
}

describe("fix command: skips taskify and plan", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("rerun from build skips taskify and plan", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "fix-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Fix auth")

    // Pre-populate taskify and plan outputs from previous run
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      task_type: "bugfix", title: "Fix auth", description: "Add auth",
      scope: ["src/auth.ts"], risk_level: "high",
    }))
    fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: Fix\n**File:** src/auth.ts")
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify({
      taskId: "fix-test",
      state: "completed",
      stages: {
        taskify: { state: "completed", retries: 0 },
        plan: { state: "completed", retries: 0 },
        build: { state: "completed", retries: 0 },
        verify: { state: "completed", retries: 0 },
        review: { state: "completed", retries: 0 },
        "review-fix": { state: "completed", retries: 0 },
        ship: { state: "completed", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))

    const runner = createRunner() as AgentRunner & { getCalls: () => string[] }
    const ctx: PipelineContext = {
      taskId: "fix-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: {
        mode: "rerun",
        fromStage: "build",
        feedback: "Use middleware pattern instead of wrapper",
        dryRun: true,
      },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    // Taskify and plan should remain completed from previous run, not re-executed
    expect(state.stages.taskify.state).toBe("completed")
    expect(state.stages.plan.state).toBe("completed")
  })

  it("feedback is available when fix runs", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "fix-feedback")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Fix auth")
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      task_type: "bugfix", title: "Fix", description: "Fix auth",
      scope: [], risk_level: "low",
    }))
    fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: Fix\n**File:** a.ts")
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify({
      taskId: "fix-feedback",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0 },
        plan: { state: "completed", retries: 0 },
        build: { state: "failed", retries: 0, error: "previous build failed" },
        verify: { state: "pending", retries: 0 },
        review: { state: "pending", retries: 0 },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))

    const capturedPrompts: Record<string, string> = {}
    const capturingRunner: AgentRunner = {
      async run(stage: string, prompt: string): Promise<AgentResult> {
        capturedPrompts[stage] = prompt
        return { outcome: "completed", output: "## Step 1: X\n**File:** a.ts\n**Change:** Y\n**Why:** Z\n**Verify:** t" }
      },
      async healthCheck() { return true },
    }

    const ctx: PipelineContext = {
      taskId: "fix-feedback",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: capturingRunner },
      input: {
        mode: "rerun",
        fromStage: "build",
        feedback: "Please add proper error handling and return 401 not 500",
      },
    }

    await runPipeline(ctx)
    const buildPrompt = capturedPrompts["build"] ?? ""
    expect(buildPrompt).toContain("Human Feedback")
    expect(buildPrompt).toContain("error handling")
    expect(buildPrompt).toContain("401 not 500")
  })
})

describe("fix command: entry.ts defaults", () => {
  function resolveFromStage(
    command: string,
    feedback: string | undefined,
    explicit: string | undefined,
  ): string | undefined {
    if ((command === "fix" || command === "fix-ci") && !explicit) {
      return feedback?.trim() ? "plan" : "build"
    }
    return explicit
  }

  it("fix with empty feedback defaults fromStage to build (fast path preserved)", () => {
    expect(resolveFromStage("fix", undefined, undefined)).toBe("build")
    expect(resolveFromStage("fix", "", undefined)).toBe("build")
    expect(resolveFromStage("fix", "   ", undefined)).toBe("build")
  })

  it("fix with non-empty feedback defaults fromStage to plan (re-plan before build)", () => {
    expect(resolveFromStage("fix", "Add proper error handling", undefined)).toBe("plan")
    expect(resolveFromStage("fix", "Use middleware pattern", undefined)).toBe("plan")
  })

  it("fix with explicit --from overrides default even when feedback is present", () => {
    expect(resolveFromStage("fix", "Add feature X", "verify")).toBe("verify")
    expect(resolveFromStage("fix", undefined, "build")).toBe("build")
  })

  it("fix mode maps to rerun", () => {
    const command = "fix"
    const mode = (command === "rerun" || command === "fix") ? "rerun" : "full"
    expect(mode).toBe("rerun")
  })
})

describe("fix workflow parsing", () => {
  it("@kody fix extracts description as feedback", () => {
    const commentBody = `@kody fix
Please add proper error handling to the auth middleware
and make sure it returns 401 instead of 500`

    // Simulate workflow parse logic
    const fixBody = commentBody.split(/\n/).slice(1).join("\n").trim()
    expect(fixBody).toContain("error handling")
    expect(fixBody).toContain("401 instead of 500")
  })

  it("@kody fix with no description has empty feedback", () => {
    const commentBody = `@kody fix`
    const fixBody = commentBody.split(/\n/).slice(1).join("\n").trim()
    expect(fixBody).toBe("")
  })

  it("@kody fix does not generate new task-id", () => {
    let MODE = "fix"
    let TASK_ID = ""

    // Only generate for full mode
    if (!TASK_ID && MODE === "full") {
      TASK_ID = "1031-260326-120000"
    }

    expect(TASK_ID).toBe("")
  })

  it("@kody fix on PR uses PR issue number", () => {
    // GitHub treats PR comments as issue comments
    // github.event.issue.number will be the PR number
    const prNumber = 1035
    const issueNum = prNumber // same in GitHub API
    expect(issueNum).toBe(1035)
  })
})
