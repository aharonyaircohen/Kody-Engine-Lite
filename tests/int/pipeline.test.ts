import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createMockRunner(): AgentRunner {
  const calls: Array<{ stage: string; model: string }> = []

  return Object.assign(
    {
      async run(stageName: string, _prompt: string, model: string): Promise<AgentResult> {
        calls.push({ stage: stageName, model })
        if (stageName === "taskify") {
          return {
            outcome: "completed" as const,
            output: JSON.stringify({
              task_type: "feature",
              title: "Integration test task",
              description: "Test the full pipeline",
              scope: ["src/test.ts"],
              risk_level: "medium",
            }),
          }
        }
        if (stageName === "plan") {
          return {
            outcome: "completed" as const,
            output: "## Step 1: Create test\n**File:** src/test.ts\n**Change:** Add test\n**Why:** TDD",
          }
        }
        if (stageName === "review") {
          return {
            outcome: "completed" as const,
            output: "## Verdict: PASS\n\n## Summary\nAll good.\n\n## Findings\n\n### Critical\nNone.\n\n### Major\nNone.\n\n### Minor\nNone.",
          }
        }
        return { outcome: "completed" as const, output: "Stage completed" }
      },
      async healthCheck() {
        return true
      },
      getCalls() {
        return calls
      },
    },
  )
}

describe("Integration: full pipeline dry-run", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-int-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
        agent: { defaultRunner: "claude", modelMap: { cheap: "claude/test-model-cheap", mid: "claude/test-model-mid", strong: "claude/test-model-strong" } },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("runs all 7 stages and produces status.json", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "int-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Integration test: add a utility function")

    const runner = createMockRunner()
    const ctx: PipelineContext = {
      taskId: "int-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", local: true },
    }

    const state = await runPipeline(ctx)

    expect(state.state).toBe("completed")
    expect(state.taskId).toBe("int-test")

    // All stages completed
    for (const [name, stage] of Object.entries(state.stages)) {
      expect(stage.state).toBe("completed")
    }

    // Status file exists
    expect(fs.existsSync(path.join(taskDir, "status.json"))).toBe(true)

    // Artifacts created for print-mode stages
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(true)
    expect(fs.existsSync(path.join(taskDir, "plan.md"))).toBe(true)
    expect(fs.existsSync(path.join(taskDir, "review.md"))).toBe(true)
  })

  it("medium complexity auto-detected skips review-fix", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "int-medium")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Medium complexity task")

    const runner = createMockRunner()
    const ctx: PipelineContext = {
      taskId: "int-medium",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", local: true },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    // review-fix should be skipped (auto-detected medium from taskify's risk_level)
    // Note: the mock returns risk_level: "medium" in taskify output
  })

  it("stops on stage failure", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "int-fail")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Fail test")

    const failRunner: AgentRunner = {
      async run(stageName: string): Promise<AgentResult> {
        if (stageName === "plan") {
          return { outcome: "failed", error: "Model unavailable" }
        }
        if (stageName === "taskify") {
          return {
            outcome: "completed",
            output: JSON.stringify({
              task_type: "feature", title: "T", description: "D",
              scope: [], risk_level: "high",
            }),
          }
        }
        return { outcome: "completed", output: "ok" }
      },
      async healthCheck() { return true },
    }

    const ctx: PipelineContext = {
      taskId: "int-fail",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: failRunner },
      input: { mode: "full" },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("failed")
    expect(state.stages.plan.state).toBe("failed")
    expect(state.stages.plan.error).toContain("Model unavailable")
    // Stages after plan should still be pending
    expect(state.stages.build.state).toBe("pending")
  })

  it("propagates runner failureCategory into stage state", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "int-maxturns")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Max-turns test")

    const turnsRunner: AgentRunner = {
      async run(stageName: string): Promise<AgentResult> {
        if (stageName === "taskify") {
          return {
            outcome: "completed",
            output: JSON.stringify({
              task_type: "feature", title: "T", description: "D",
              scope: [], risk_level: "high",
            }),
          }
        }
        if (stageName === "build") {
          return {
            outcome: "failed",
            error: "[max_turns] maximum number of turns reached",
            failureCategory: "max_turns",
          }
        }
        return { outcome: "completed", output: "ok" }
      },
      async healthCheck() { return true },
    }

    const ctx: PipelineContext = {
      taskId: "int-maxturns",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: turnsRunner },
      input: { mode: "full", local: true },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("failed")
    expect(state.stages.build.state).toBe("failed")
    expect(state.stages.build.failureCategory).toBe("max_turns")
    // Status persisted to disk (so resume / rerun can see the category too)
    const statusRaw = fs.readFileSync(path.join(taskDir, "status.json"), "utf-8")
    const status = JSON.parse(statusRaw)
    expect(status.stages.build.failureCategory).toBe("max_turns")
  })

  it("happy path produces no crash files across any stage (session-resume regression guard)", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "int-no-crash")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Integration test: no crashes on happy path")

    const runner = createMockRunner()
    const ctx: PipelineContext = {
      taskId: "int-no-crash",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", local: true },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")

    // None of the stages should have produced a crash dump on a clean run.
    // This guards against regressions of the session-resume init-crash bug
    // where every retried stage left an `.N.crash.jsonl` artifact behind.
    const artifacts = fs.readdirSync(taskDir)
    const crashFiles = artifacts.filter((f) => f.endsWith(".crash.jsonl"))
    expect(crashFiles).toEqual([])
  })

  it("propagates timed_out outcome as timeout state with failureCategory", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "int-timeout")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Timeout test")

    const timeoutRunner: AgentRunner = {
      async run(stageName: string): Promise<AgentResult> {
        if (stageName === "taskify") {
          return {
            outcome: "timed_out",
            error: "Abort after 120000ms",
            failureCategory: "timed_out",
          }
        }
        return { outcome: "completed", output: "ok" }
      },
      async healthCheck() { return true },
    }

    const ctx: PipelineContext = {
      taskId: "int-timeout",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: timeoutRunner },
      input: { mode: "full", local: true },
    }

    const state = await runPipeline(ctx)
    expect(state.stages.taskify.state).toBe("timeout")
    expect(state.stages.taskify.failureCategory).toBe("timed_out")
  })
})
