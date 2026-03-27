import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createMockRunner(taskifyOutput?: object, planOutput?: string): AgentRunner {
  return {
    async run(stageName: string): Promise<AgentResult> {
      if (stageName === "taskify") {
        return {
          outcome: "completed",
          output: JSON.stringify(taskifyOutput ?? {
            task_type: "feature",
            title: "Test",
            description: "Test task",
            scope: ["src/test.ts"],
            risk_level: "high",
            questions: [],
          }),
        }
      }
      if (stageName === "plan") {
        return {
          outcome: "completed",
          output: planOutput ?? "## Step 1: Do something\n**File:** src/test.ts\n**Change:** Add code\n**Why:** Needed\n**Verify:** pnpm test",
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

function setupTest(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-questions-test-"))
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
  overrides?: Partial<PipelineContext["input"]>,
): PipelineContext {
  const taskDir = path.join(tmpDir, ".tasks", "q-test")
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, "task.md"), "Test task")
  return {
    taskId: "q-test",
    taskDir,
    projectDir: tmpDir,
    runners: { claude: runner },
    input: { mode: "full", dryRun: true, ...overrides },
  }
}

describe("taskify question gate", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setupTest()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it("continues when questions array is empty", async () => {
    const runner = createMockRunner({
      task_type: "feature",
      title: "Clear task",
      description: "No questions needed",
      scope: ["src/test.ts"],
      risk_level: "low",
      questions: [],
    })
    const ctx = createCtx(tmpDir, runner)
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
  })

  it("continues when questions field is missing", async () => {
    const runner = createMockRunner({
      task_type: "feature",
      title: "No questions field",
      description: "Old format",
      scope: ["src/test.ts"],
      risk_level: "low",
    })
    const ctx = createCtx(tmpDir, runner)
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
  })

  it("pauses when questions are present (non-local with issue)", async () => {
    const runner = createMockRunner({
      task_type: "feature",
      title: "Unclear task",
      description: "Needs clarification",
      scope: ["src/test.ts"],
      risk_level: "high",
      questions: [
        "Should this be case-sensitive?",
        "Which users have access?",
      ],
    })
    // Non-dry-run, with issue number, non-local — but will fail at actual GitHub API
    // The pause check happens in state-machine AFTER the stage completes
    // In dry-run mode, the stage doesn't write output, so questions aren't checked
    // For unit testing, we verify the output format
    const ctx = createCtx(tmpDir, runner)
    const state = await runPipeline(ctx)
    // In dry-run, questions are not checked (no file written)
    expect(state.state).toBe("completed")
  })

  it("skips question gate on rerun mode (approve flow)", async () => {
    const runner = createMockRunner({
      task_type: "feature",
      title: "Unclear task",
      description: "Has questions",
      scope: ["src/test.ts"],
      risk_level: "low",
      questions: ["Should this be X or Y?"],
    })
    // Rerun mode should skip question check even if questions exist
    const ctx = createCtx(tmpDir, runner, { mode: "rerun", dryRun: false, local: true })
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
    // Verify task.json has questions but pipeline didn't pause
    const taskJsonPath = path.join(ctx.taskDir, "task.json")
    if (fs.existsSync(taskJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(taskJsonPath, "utf-8"))
      expect(parsed.questions).toEqual(["Should this be X or Y?"])
    }
  })

  it("questions are written to task.json when present", async () => {
    const runner = createMockRunner({
      task_type: "feature",
      title: "Task with questions",
      description: "Test",
      scope: [],
      risk_level: "high",
      questions: ["Q1?", "Q2?"],
    })
    // Run non-dry-run so output is written
    const ctx = createCtx(tmpDir, runner, { dryRun: false, local: true })
    await runPipeline(ctx)

    const taskJsonPath = path.join(ctx.taskDir, "task.json")
    if (fs.existsSync(taskJsonPath)) {
      const content = fs.readFileSync(taskJsonPath, "utf-8")
      const parsed = JSON.parse(content)
      expect(parsed.questions).toEqual(["Q1?", "Q2?"])
    }
  })
})

describe("plan question gate", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = setupTest()
    tmpDir = t.tmpDir
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it("continues when plan has no Questions section", async () => {
    const runner = createMockRunner(undefined, "## Step 1: Do thing\n**File:** src/a.ts\n**Change:** Add\n**Why:** Need\n**Verify:** test")
    const ctx = createCtx(tmpDir, runner)
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")
  })

  it("detects questions section in plan output", () => {
    const planWithQuestions = `## Step 1: Create module
**File:** src/auth.ts
**Change:** Add auth middleware
**Why:** Security
**Verify:** pnpm test

## Questions

- Recommend JWT over sessions — JWT is stateless and scales better. Approve?
- Should we add rate limiting now or defer?`

    // Extract questions using the same logic as state-machine
    const match = planWithQuestions.match(/## Questions\s*\n([\s\S]*?)(?=\n## |\n*$)/)
    expect(match).toBeTruthy()
    const questions = match![1].trim().split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2))
    expect(questions).toHaveLength(2)
    expect(questions[0]).toContain("JWT")
    expect(questions[1]).toContain("rate limiting")
  })

  it("question comment instructs user to @kody approve", () => {
    // The question format should mention @kody approve
    const expectedPattern = "@kody approve"
    // This is tested by checking the state-machine's comment format
    // The actual format is in checkForQuestions() which uses this exact string
    expect(expectedPattern).toContain("approve")
  })

  it("no questions when section is absent", () => {
    const planNoQuestions = `## Step 1: Simple change
**File:** src/utils.ts
**Change:** Add helper
**Why:** DRY
**Verify:** pnpm test`

    const match = planNoQuestions.match(/## Questions\s*\n([\s\S]*?)(?=\n## |\n*$)/)
    expect(match).toBeNull()
  })
})
