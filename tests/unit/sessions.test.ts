import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createCapturingRunner(): {
  runner: AgentRunner
  calls: Array<{ stage: string; options: Record<string, unknown> }>
} {
  const calls: Array<{ stage: string; options: Record<string, unknown> }> = []
  const runner: AgentRunner = {
    async run(stageName: string, _prompt: string, _model: string, _timeout: number, _taskDir: string, options?: Record<string, unknown>): Promise<AgentResult> {
      calls.push({ stage: stageName, options: options ?? {} })
      if (stageName === "taskify") {
        return {
          outcome: "completed",
          output: JSON.stringify({
            task_type: "feature", title: "Test", description: "Test",
            scope: ["src/test.ts"], risk_level: "high", questions: [],
          }),
        }
      }
      if (stageName === "plan") {
        return { outcome: "completed", output: "## Step 1: X\n**File:** a.ts\n**Change:** Y\n**Why:** Z\n**Verify:** test" }
      }
      if (stageName === "review") {
        return { outcome: "completed", output: "## Verdict: PASS\nAll good." }
      }
      return { outcome: "completed", output: "Done" }
    },
    async healthCheck() { return true },
  }
  return { runner, calls }
}

function setup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-sessions-"))
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

describe("session management", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("taskify and plan share the 'explore' session", async () => {
    const { runner, calls } = createCapturingRunner()
    const taskDir = path.join(tmpDir, ".tasks", "session-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")

    const ctx: PipelineContext = {
      taskId: "session-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", dryRun: true, local: true },
    }

    // dryRun skips agent calls, so we need to run without dryRun
    // but with a mock runner that captures options
    ctx.input.dryRun = false
    await runPipeline(ctx)

    const taskifyCall = calls.find(c => c.stage === "taskify")
    const planCall = calls.find(c => c.stage === "plan")

    expect(taskifyCall).toBeDefined()
    expect(planCall).toBeDefined()

    // Both should have sessionId
    expect(taskifyCall!.options.sessionId).toBeDefined()
    expect(planCall!.options.sessionId).toBeDefined()

    // Same session ID (both in "explore" group)
    expect(taskifyCall!.options.sessionId).toBe(planCall!.options.sessionId)

    // Taskify creates, plan resumes
    expect(taskifyCall!.options.resumeSession).toBe(false)
    expect(planCall!.options.resumeSession).toBe(true)
  })

  it("build gets a different session than explore", async () => {
    const { runner, calls } = createCapturingRunner()
    const taskDir = path.join(tmpDir, ".tasks", "session-test-2")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")

    const ctx: PipelineContext = {
      taskId: "session-test-2",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    const taskifyCall = calls.find(c => c.stage === "taskify")
    const buildCall = calls.find(c => c.stage === "build")

    expect(taskifyCall!.options.sessionId).toBeDefined()
    expect(buildCall!.options.sessionId).toBeDefined()

    // Different sessions (explore vs build)
    expect(taskifyCall!.options.sessionId).not.toBe(buildCall!.options.sessionId)
  })

  it("review gets a fresh session (not build)", async () => {
    const { runner, calls } = createCapturingRunner()
    const taskDir = path.join(tmpDir, ".tasks", "session-test-3")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")

    const ctx: PipelineContext = {
      taskId: "session-test-3",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    const buildCall = calls.find(c => c.stage === "build")
    const reviewCall = calls.find(c => c.stage === "review")

    expect(buildCall!.options.sessionId).not.toBe(reviewCall!.options.sessionId)
    // Review creates a new session
    expect(reviewCall!.options.resumeSession).toBe(false)
  })

  it("sessions are persisted in status.json", async () => {
    const { runner } = createCapturingRunner()
    const taskDir = path.join(tmpDir, ".tasks", "session-persist")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")

    const ctx: PipelineContext = {
      taskId: "session-persist",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", dryRun: true, local: true },
    }

    await runPipeline(ctx)

    const status = JSON.parse(fs.readFileSync(path.join(taskDir, "status.json"), "utf-8"))
    // Sessions may be empty in dryRun since agent stages are skipped
    // but the field should exist
    expect(status.sessions).toBeDefined()
  })

  it("review-fix resumes the build session", async () => {
    const { runner, calls } = createCapturingRunner()
    const taskDir = path.join(tmpDir, ".tasks", "session-reviewfix")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")

    const ctx: PipelineContext = {
      taskId: "session-reviewfix",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: runner },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    const buildCall = calls.find(c => c.stage === "build")
    const reviewFixCall = calls.find(c => c.stage === "review-fix")

    expect(buildCall).toBeDefined()
    expect(reviewFixCall).toBeDefined()

    // review-fix shares build session
    expect(buildCall!.options.sessionId).toBe(reviewFixCall!.options.sessionId)
    expect(reviewFixCall!.options.resumeSession).toBe(true)
  })
})
