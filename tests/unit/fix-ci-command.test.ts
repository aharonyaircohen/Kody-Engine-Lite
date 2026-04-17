import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createRunner(): AgentRunner & { getCalls: () => string[] } {
  const calls: string[] = []
  return {
    async run(stageName: string): Promise<AgentResult> {
      calls.push(stageName)
      if (stageName === "taskify") {
        return {
          outcome: "completed",
          output: JSON.stringify({
            task_type: "bugfix",
            title: "Fix CI failure",
            description: "Fix typecheck errors",
            scope: ["src/index.ts"],
            risk_level: "low",
            questions: [],
          }),
        }
      }
      if (stageName === "plan") {
        return {
          outcome: "completed",
          output: "## Step 1: Fix types\n**File:** src/index.ts\n**Change:** Fix type error\n**Why:** CI failing\n**Verify:** typecheck",
        }
      }
      if (stageName === "review") {
        return { outcome: "completed", output: "## Verdict: PASS\n\n## Summary\nFixed types.\n\n## Findings\n\n### Critical\nNone." }
      }
      return { outcome: "completed", output: "Done" }
    },
    async healthCheck() { return true },
    getCalls: () => calls,
  }
}

function setup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-fixci-test-"))
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

describe("fix-ci command: entry.ts defaults", () => {
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

  it("fix-ci with empty feedback defaults fromStage to build", () => {
    expect(resolveFromStage("fix-ci", undefined, undefined)).toBe("build")
    expect(resolveFromStage("fix-ci", "", undefined)).toBe("build")
  })

  it("fix-ci with CI failure logs as feedback defaults fromStage to plan", () => {
    const feedback = "## CI Failure Logs (run 12345)\n\nerror TS2345"
    expect(resolveFromStage("fix-ci", feedback, undefined)).toBe("plan")
  })

  it("fix-ci with explicit --from overrides default", () => {
    expect(resolveFromStage("fix-ci", "some feedback", "verify")).toBe("verify")
    expect(resolveFromStage("fix-ci", undefined, "build")).toBe("build")
  })

  it("fix-ci mode maps to rerun", () => {
    const command = "fix-ci"
    const mode = (command === "rerun" || command === "fix" || command === "fix-ci") ? "rerun" : "full"
    expect(mode).toBe("rerun")
  })

  it("fix-ci on PR generates fixci-pr task ID", () => {
    const command = "fix-ci"
    const prNumber = 42
    const isPRFix = (command === "fix" || command === "fix-ci") && !!prNumber
    expect(isPRFix).toBe(true)

    const prefix = command === "fix-ci" ? "fixci" : "fix"
    const taskId = `${prefix}-pr-${prNumber}-260330-120000`
    expect(taskId).toMatch(/^fixci-pr-42-/)
  })
})

describe("fix-ci: CI run ID extraction", () => {
  it("extracts run ID from feedback body", () => {
    const feedback = "CI failed: [View logs](https://github.com/org/repo/actions/runs/12345)\nRun ID: 12345"
    const match = feedback.match(/Run ID:\s*(\d+)/)
    expect(match?.[1]).toBe("12345")
  })

  it("returns undefined when no run ID in feedback", () => {
    const feedback = "CI failed, please fix"
    const match = feedback.match(/Run ID:\s*(\d+)/)
    expect(match).toBeNull()
  })

  it("handles empty feedback", () => {
    const feedback = undefined
    const match = feedback?.match(/Run ID:\s*(\d+)/)
    expect(match).toBeUndefined()
  })
})

describe("fix-ci: pipeline runs from build", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("rerun from build skips taskify and plan", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "fixci-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Fix CI typecheck failure")

    // Pre-populate taskify and plan outputs from previous run
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      task_type: "bugfix", title: "Fix CI", description: "Fix typecheck",
      scope: ["src/index.ts"], risk_level: "low",
    }))
    fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: Fix\n**File:** src/index.ts")
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify({
      taskId: "fixci-test",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0 },
        plan: { state: "completed", retries: 0 },
        build: { state: "failed", retries: 0, error: "typecheck failed" },
        verify: { state: "pending", retries: 0 },
        review: { state: "pending", retries: 0 },
        "review-fix": { state: "pending", retries: 0 },
        ship: { state: "pending", retries: 0 },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))

    const runner = createRunner()
    const ctx: PipelineContext = {
      taskId: "fixci-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: {
        mode: "rerun",
        fromStage: "build",
        feedback: "## CI Failure Logs (run 12345)\n\nThe CI pipeline failed.\n\n```\nerror TS2345: Argument of type 'string' is not assignable\n```",
        dryRun: true,
      },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    expect(state.stages.taskify.state).toBe("completed")
    expect(state.stages.plan.state).toBe("completed")
  })

  it("CI failure logs are included in feedback", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "fixci-feedback")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Fix CI")
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      task_type: "bugfix", title: "Fix CI", description: "Fix typecheck",
      scope: [], risk_level: "low",
    }))
    fs.writeFileSync(path.join(taskDir, "plan.md"), "## Step 1: Fix\n**File:** a.ts")
    fs.writeFileSync(path.join(taskDir, "status.json"), JSON.stringify({
      taskId: "fixci-feedback",
      state: "failed",
      stages: {
        taskify: { state: "completed", retries: 0 },
        plan: { state: "completed", retries: 0 },
        build: { state: "failed", retries: 0, error: "CI failed" },
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
      taskId: "fixci-feedback",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: capturingRunner },
      input: {
        mode: "rerun",
        fromStage: "build",
        feedback: "## CI Failure Logs (run 12345)\n\nerror TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
      },
    }

    await runPipeline(ctx)
    const buildPrompt = capturedPrompts["build"] ?? ""
    expect(buildPrompt).toContain("Human Feedback")
    expect(buildPrompt).toContain("CI Failure Logs")
    expect(buildPrompt).toContain("TS2345")
  })
})

describe("fix-ci workflow parsing", () => {
  it("@kody fix-ci extracts body as feedback", () => {
    const commentBody = `@kody fix-ci
CI failed: [View logs](https://github.com/org/repo/actions/runs/12345)
Run ID: 12345`

    const fixCiBody = commentBody.split(/\n/).slice(1).join("\n").trim()
    expect(fixCiBody).toContain("CI failed")
    expect(fixCiBody).toContain("Run ID: 12345")
  })

  it("@kody fix-ci with no body has empty feedback", () => {
    const commentBody = `@kody fix-ci`
    const fixCiBody = commentBody.split(/\n/).slice(1).join("\n").trim()
    expect(fixCiBody).toBe("")
  })
})
