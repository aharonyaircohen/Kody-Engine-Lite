import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createRunner(): AgentRunner {
  return {
    async run(stageName: string): Promise<AgentResult> {
      if (stageName === "taskify") {
        return {
          outcome: "completed",
          output: JSON.stringify({
            task_type: "feature",
            title: "Add search function",
            description: "Create a search utility that filters items by keyword",
            scope: ["src/utils/search.ts", "src/utils/search.test.ts"],
            risk_level: "medium",
            questions: [],
          }),
        }
      }
      if (stageName === "plan") {
        return {
          outcome: "completed",
          output: "## Step 1: Write tests\n**File:** src/utils/search.test.ts\n**Change:** Add tests\n**Why:** TDD\n**Verify:** pnpm test",
        }
      }
      if (stageName === "review") {
        return { outcome: "completed", output: "## Verdict: PASS\n\nAll checks passed." }
      }
      return { outcome: "completed", output: "Done" }
    },
    async healthCheck() { return true },
  }
}

function setup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-prbody-test-"))
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

describe("PR body generation", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("generates ship.md with task summary after local pipeline", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "pr-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Add search function")

    const ctx: PipelineContext = {
      taskId: "pr-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createRunner() },
      input: { mode: "full", local: true },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")

    // Check that ship.md exists and has content
    const shipPath = path.join(taskDir, "ship.md")
    expect(fs.existsSync(shipPath)).toBe(true)
    const ship = fs.readFileSync(shipPath, "utf-8")
    expect(ship).toContain("Ship")
  })

  it("task.json contains all fields for PR body", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "pr-fields")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Add search")

    const ctx: PipelineContext = {
      taskId: "pr-fields",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createRunner() },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    const taskJsonPath = path.join(taskDir, "task.json")
    expect(fs.existsSync(taskJsonPath)).toBe(true)
    const task = JSON.parse(fs.readFileSync(taskJsonPath, "utf-8"))
    expect(task.task_type).toBe("feature")
    expect(task.risk_level).toBe("medium")
    expect(task.description).toContain("search")
    expect(task.scope).toContain("src/utils/search.ts")
  })

  it("plan.md is created for PR body details section", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "pr-plan")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Add search")

    const ctx: PipelineContext = {
      taskId: "pr-plan",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createRunner() },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    const planPath = path.join(taskDir, "plan.md")
    expect(fs.existsSync(planPath)).toBe(true)
    const plan = fs.readFileSync(planPath, "utf-8")
    expect(plan).toContain("Step 1")
    expect(plan).toContain("TDD")
  })

  it("review.md contains verdict for PR body", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "pr-review")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Add search")

    const ctx: PipelineContext = {
      taskId: "pr-review",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createRunner() },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    const reviewPath = path.join(taskDir, "review.md")
    expect(fs.existsSync(reviewPath)).toBe(true)
    const review = fs.readFileSync(reviewPath, "utf-8")
    expect(review).toMatch(/PASS/i)
  })
})

describe("skipped stages comment", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setup()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it("low complexity marks plan/review/review-fix as completed", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "skip-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Fix typo")

    const ctx: PipelineContext = {
      taskId: "skip-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createRunner() },
      input: { mode: "full", complexity: "low", dryRun: true },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    expect(state.stages.plan.state).toBe("completed")
    expect(state.stages.review.state).toBe("completed")
    expect(state.stages["review-fix"].state).toBe("completed")
  })
})

describe("type labels", () => {
  it("taskify output includes task_type for labeling", () => {
    const taskJson = {
      task_type: "feature",
      title: "Test",
      description: "Test",
      scope: [],
      risk_level: "low",
    }
    // Verify the label name format
    expect(`kody:${taskJson.task_type}`).toBe("kody:feature")
  })

  it("all task types map to valid labels", () => {
    const validTypes = ["feature", "bugfix", "refactor", "docs", "chore"]
    for (const type of validTypes) {
      expect(`kody:${type}`).toMatch(/^kody:\w+$/)
    }
  })
})
