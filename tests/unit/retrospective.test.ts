import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import type { AgentRunner, AgentResult, PipelineStatus, PipelineContext } from "../../src/types.js"
import {
  collectRunContext,
  readPreviousRetrospectives,
  appendRetrospectiveEntry,
  runRetrospective,
} from "../../src/retrospective.js"
import type { RetrospectiveEntry } from "../../src/retrospective.js"

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "retro-test-"))
}

function makeState(overrides?: Partial<PipelineStatus>): PipelineStatus {
  const now = new Date().toISOString()
  return {
    taskId: "test-task-1",
    state: "completed",
    stages: {
      taskify: { state: "completed", retries: 0, startedAt: now, completedAt: now },
      plan: { state: "completed", retries: 0, startedAt: now, completedAt: now },
      build: { state: "completed", retries: 0, startedAt: now, completedAt: now },
      verify: { state: "completed", retries: 0, startedAt: now, completedAt: now },
      review: { state: "completed", retries: 0, startedAt: now, completedAt: now },
      "review-fix": { state: "completed", retries: 0 },
      ship: { state: "completed", retries: 0, startedAt: now, completedAt: now },
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeCtx(taskDir: string, projectDir: string): PipelineContext {
  const mockRunner: AgentRunner = {
    async run(): Promise<AgentResult> {
      return { outcome: "completed", output: "{}" }
    },
    async healthCheck() { return true },
  }
  return {
    taskId: "test-task-1",
    taskDir,
    projectDir,
    runners: { claude: mockRunner },
    input: { mode: "full" },
  }
}

function makeEntry(overrides?: Partial<RetrospectiveEntry>): RetrospectiveEntry {
  return {
    timestamp: new Date().toISOString(),
    taskId: "task-1",
    outcome: "completed",
    durationMs: 5000,
    stageResults: {},
    observation: "Clean run",
    patternMatch: null,
    suggestion: "No changes needed",
    pipelineFlaw: null,
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("collectRunContext", () => {
  let taskDir: string
  let projectDir: string

  beforeEach(() => {
    projectDir = makeTmpDir()
    taskDir = path.join(projectDir, ".tasks", "test-1")
    fs.mkdirSync(taskDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("includes task ID and outcome", () => {
    const state = makeState()
    const ctx = makeCtx(taskDir, projectDir)
    const result = collectRunContext(ctx, state, Date.now() - 5000)

    expect(result).toContain("test-task-1")
    expect(result).toContain("completed")
  })

  it("includes stage results with retries", () => {
    const state = makeState({
      stages: {
        ...makeState().stages,
        verify: { state: "failed", retries: 2, error: "Type errors" },
      },
      state: "failed",
    })
    const ctx = makeCtx(taskDir, projectDir)
    const result = collectRunContext(ctx, state, Date.now() - 10000)

    expect(result).toContain("verify: failed (2 retries")
    expect(result).toContain("Type errors")
  })

  it("includes artifact contents when present", () => {
    fs.writeFileSync(path.join(taskDir, "task.md"), "Fix the login bug")
    fs.writeFileSync(path.join(taskDir, "verify.md"), "# Verification Report\n## Result: FAIL")

    const state = makeState()
    const ctx = makeCtx(taskDir, projectDir)
    const result = collectRunContext(ctx, state, Date.now())

    expect(result).toContain("Fix the login bug")
    expect(result).toContain("Verification Report")
  })

  it("truncates long artifacts", () => {
    fs.writeFileSync(path.join(taskDir, "verify.md"), "x".repeat(2000))

    const state = makeState()
    const ctx = makeCtx(taskDir, projectDir)
    const result = collectRunContext(ctx, state, Date.now())

    expect(result).toContain("...(truncated)")
  })

  it("handles missing artifacts gracefully", () => {
    const state = makeState()
    const ctx = makeCtx(taskDir, projectDir)
    const result = collectRunContext(ctx, state, Date.now())

    // Should not throw, should not contain artifact headers for missing files
    expect(result).toContain("Stage Results")
    expect(result).not.toContain("#### task.md")
  })
})

describe("readPreviousRetrospectives", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns empty array when file does not exist", () => {
    const result = readPreviousRetrospectives(projectDir)
    expect(result).toEqual([])
  })

  it("parses valid JSONL entries", () => {
    const logDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(logDir, { recursive: true })

    const entry1 = makeEntry({ taskId: "task-1", observation: "First run" })
    const entry2 = makeEntry({ taskId: "task-2", observation: "Second run" })

    fs.writeFileSync(
      path.join(logDir, "observer-log.jsonl"),
      JSON.stringify(entry1) + "\n" + JSON.stringify(entry2) + "\n",
    )

    const result = readPreviousRetrospectives(projectDir)
    expect(result).toHaveLength(2)
    expect(result[0].taskId).toBe("task-1")
    expect(result[1].taskId).toBe("task-2")
  })

  it("skips corrupt lines", () => {
    const logDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(logDir, { recursive: true })

    const valid = makeEntry({ taskId: "valid" })
    fs.writeFileSync(
      path.join(logDir, "observer-log.jsonl"),
      JSON.stringify(valid) + "\n" + "NOT VALID JSON\n" + JSON.stringify(valid) + "\n",
    )

    const result = readPreviousRetrospectives(projectDir)
    expect(result).toHaveLength(2)
  })

  it("returns only last N entries", () => {
    const logDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(logDir, { recursive: true })

    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify(makeEntry({ taskId: `task-${i}` })),
    ).join("\n") + "\n"

    fs.writeFileSync(path.join(logDir, "observer-log.jsonl"), lines)

    const result = readPreviousRetrospectives(projectDir, 5)
    expect(result).toHaveLength(5)
    expect(result[0].taskId).toBe("task-15")
    expect(result[4].taskId).toBe("task-19")
  })

  it("handles empty file", () => {
    const logDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, "observer-log.jsonl"), "")

    const result = readPreviousRetrospectives(projectDir)
    expect(result).toEqual([])
  })
})

describe("appendRetrospectiveEntry", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("creates directory and file if missing", () => {
    const entry = makeEntry()
    appendRetrospectiveEntry(projectDir, entry)

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    expect(fs.existsSync(logPath)).toBe(true)
  })

  it("appends one JSON line per call", () => {
    appendRetrospectiveEntry(projectDir, makeEntry({ taskId: "a" }))
    appendRetrospectiveEntry(projectDir, makeEntry({ taskId: "b" }))

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean)

    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).taskId).toBe("a")
    expect(JSON.parse(lines[1]).taskId).toBe("b")
  })

  it("each line is valid JSON", () => {
    appendRetrospectiveEntry(projectDir, makeEntry({ observation: "test with \"quotes\" and\nnewlines" }))

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    const line = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean)[0]

    expect(() => JSON.parse(line)).not.toThrow()
  })
})

describe("runRetrospective", () => {
  let taskDir: string
  let projectDir: string

  beforeEach(() => {
    projectDir = makeTmpDir()
    taskDir = path.join(projectDir, ".tasks", "test-1")
    fs.mkdirSync(taskDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  function makeCtxWithRunner(runner: AgentRunner): PipelineContext {
    return {
      taskId: "test-task-1",
      taskDir,
      projectDir,
      runners: { claude: runner },
      input: { mode: "full" },
    }
  }

  it("appends entry on successful LLM response", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: JSON.stringify({
            observation: "Clean run, all stages passed",
            patternMatch: null,
            suggestion: "Consider caching plan output",
            pipelineFlaw: null,
          }),
        }
      },
      async healthCheck() { return true },
    }

    const ctx = makeCtxWithRunner(runner)
    const state = makeState()
    await runRetrospective(ctx, state, Date.now() - 5000)

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    expect(fs.existsSync(logPath)).toBe(true)

    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").split("\n")[0])
    expect(entry.taskId).toBe("test-task-1")
    expect(entry.outcome).toBe("completed")
    expect(entry.observation).toBe("Clean run, all stages passed")
    expect(entry.suggestion).toBe("Consider caching plan output")
    expect(entry.pipelineFlaw).toBeNull()
  })

  it("records pipeline flaw when detected", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: JSON.stringify({
            observation: "Verify failed twice on type errors",
            patternMatch: "Same pattern in 3 of last 5 runs",
            suggestion: "Add type checking to build prompt",
            pipelineFlaw: {
              component: "build prompt",
              issue: "No type safety guidance in build prompt",
              evidence: "Type errors in 3 of last 5 runs",
            },
          }),
        }
      },
      async healthCheck() { return true },
    }

    const ctx = makeCtxWithRunner(runner)
    const state = makeState({ state: "failed" })
    await runRetrospective(ctx, state, Date.now() - 10000)

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").split("\n")[0])
    expect(entry.outcome).toBe("failed")
    expect(entry.pipelineFlaw).toEqual({
      component: "build prompt",
      issue: "No type safety guidance in build prompt",
      evidence: "Type errors in 3 of last 5 runs",
    })
    expect(entry.patternMatch).toBe("Same pattern in 3 of last 5 runs")
  })

  it("records deterministic stage results regardless of LLM output", async () => {
    const now = new Date().toISOString()
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: JSON.stringify({
            observation: "test",
            patternMatch: null,
            suggestion: "none",
            pipelineFlaw: null,
          }),
        }
      },
      async healthCheck() { return true },
    }

    const state = makeState({
      stages: {
        ...makeState().stages,
        verify: { state: "failed", retries: 2, error: "Typecheck failed", startedAt: now, completedAt: now },
      },
      state: "failed",
    })

    const ctx = makeCtxWithRunner(runner)
    await runRetrospective(ctx, state, Date.now() - 8000)

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").split("\n")[0])
    expect(entry.failedStage).toBe("verify")
    expect(entry.stageResults.verify.state).toBe("failed")
    expect(entry.stageResults.verify.retries).toBe(2)
    expect(entry.stageResults.verify.error).toBe("Typecheck failed")
  })

  it("does not crash when LLM returns invalid JSON", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return { outcome: "completed", output: "This is not JSON at all" }
      },
      async healthCheck() { return true },
    }

    const ctx = makeCtxWithRunner(runner)
    const state = makeState()

    // Should not throw
    await runRetrospective(ctx, state, Date.now())

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    expect(fs.existsSync(logPath)).toBe(true)

    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").split("\n")[0])
    expect(entry.observation).toBe("Retrospective analysis unavailable")
  })

  it("does not crash when runner fails", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return { outcome: "failed", error: "Runner crashed" }
      },
      async healthCheck() { return true },
    }

    const ctx = makeCtxWithRunner(runner)
    const state = makeState()

    await runRetrospective(ctx, state, Date.now())

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").split("\n")[0])
    expect(entry.observation).toBe("Retrospective analysis unavailable")
  })

  it("does not crash when runner throws", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        throw new Error("Unexpected explosion")
      },
      async healthCheck() { return true },
    }

    const ctx = makeCtxWithRunner(runner)
    const state = makeState()

    // Should not throw — entire function is wrapped in try-catch
    await expect(runRetrospective(ctx, state, Date.now())).resolves.toBeUndefined()
  })

  it("handles markdown-fenced JSON response", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: '```json\n{"observation":"fenced","patternMatch":null,"suggestion":"test","pipelineFlaw":null}\n```',
        }
      },
      async healthCheck() { return true },
    }

    const ctx = makeCtxWithRunner(runner)
    const state = makeState()
    await runRetrospective(ctx, state, Date.now())

    const logPath = path.join(projectDir, ".kody", "memory", "observer-log.jsonl")
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").split("\n")[0])
    expect(entry.observation).toBe("fenced")
  })

  it("includes previous retrospectives in prompt", async () => {
    // Seed a previous entry
    const memDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(
      path.join(memDir, "observer-log.jsonl"),
      JSON.stringify(makeEntry({ taskId: "prev-task", observation: "Previous run was clean" })) + "\n",
    )

    let capturedPrompt = ""
    const runner: AgentRunner = {
      async run(_stage: string, prompt: string): Promise<AgentResult> {
        capturedPrompt = prompt
        return {
          outcome: "completed",
          output: JSON.stringify({
            observation: "test",
            patternMatch: null,
            suggestion: "none",
            pipelineFlaw: null,
          }),
        }
      },
      async healthCheck() { return true },
    }

    const ctx = makeCtxWithRunner(runner)
    const state = makeState()
    await runRetrospective(ctx, state, Date.now())

    expect(capturedPrompt).toContain("prev-task")
    expect(capturedPrompt).toContain("Previous run was clean")
  })
})
