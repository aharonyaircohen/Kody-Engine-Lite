import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createRunner(riskLevel: string): AgentRunner {
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
            risk_level: riskLevel,
            questions: [],
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-riskgate-"))
  fs.writeFileSync(
    path.join(tmpDir, "kody.config.json"),
    JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
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
  const taskId = "riskgate-test"
  const taskDir = path.join(tmpDir, ".kody/tasks", taskId)
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, "task.md"), "Test task for risk gate")
  return {
    taskId,
    taskDir,
    projectDir: tmpDir,
    runners: { claude: runner },
    input: { mode: "full", ...inputOverrides },
  }
}

describe("risk gate", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("pauses after plan for HIGH complexity (CI mode with issue)", async () => {
    const runner = createRunner("high")
    const ctx = createCtx(tmpDir, runner, {
      local: false,
      issueNumber: 99,
    })

    const state = await runPipeline(ctx)

    expect(state.state).toBe("failed")
    expect(state.stages.taskify.state).toBe("completed")
    expect(state.stages.plan.state).toBe("completed")
    expect(state.stages.plan.error).toContain("risk gate")
    expect(state.stages.plan.error).toContain("awaiting approval")
    // Build should NOT have started
    expect(state.stages.build.state).toBe("pending")
  })

  it("does NOT pause for MEDIUM complexity", async () => {
    const runner = createRunner("medium")
    const ctx = createCtx(tmpDir, runner, {
      local: false,
      issueNumber: 99,
      dryRun: true,
    })

    const state = await runPipeline(ctx)

    expect(state.state).toBe("completed")
    // review-fix is skipped for medium complexity
    expect(state.stages.build.state).toBe("completed")
  })

  it("does NOT pause for LOW complexity", async () => {
    const runner = createRunner("low")
    const ctx = createCtx(tmpDir, runner, {
      local: false,
      issueNumber: 99,
      dryRun: true,
    })

    const state = await runPipeline(ctx)

    expect(state.state).toBe("completed")
    expect(state.stages.build.state).toBe("completed")
  })

  it("does NOT pause in local mode", async () => {
    const runner = createRunner("high")
    const ctx = createCtx(tmpDir, runner, {
      local: true,
      dryRun: true,
    })

    const state = await runPipeline(ctx)

    expect(state.state).toBe("completed")
    expect(state.stages.build.state).toBe("completed")
  })

  it("does NOT pause on rerun (already approved)", async () => {
    const runner = createRunner("high")
    const ctx = createCtx(tmpDir, runner, {
      mode: "rerun",
      fromStage: "plan",
      local: false,
      issueNumber: 99,
      dryRun: true,
    })

    const state = await runPipeline(ctx)

    // Should proceed past plan without pausing
    expect(state.stages.plan.state).toBe("completed")
    expect(state.stages.plan.error).toBeUndefined()
    expect(state.stages.build.state).toBe("completed")
  })

  it("plan.md is written before gate triggers", async () => {
    const runner = createRunner("high")
    const ctx = createCtx(tmpDir, runner, {
      local: false,
      issueNumber: 99,
    })

    await runPipeline(ctx)

    // Plan file should exist (stage completed before gate paused)
    const planPath = path.join(ctx.taskDir, "plan.md")
    expect(fs.existsSync(planPath)).toBe(true)
  })

  it("does NOT pause when no issue number", async () => {
    const runner = createRunner("high")
    const ctx = createCtx(tmpDir, runner, {
      local: false,
      dryRun: true,
      // no issueNumber
    })

    const state = await runPipeline(ctx)

    expect(state.state).toBe("completed")
    expect(state.stages.build.state).toBe("completed")
  })
})
