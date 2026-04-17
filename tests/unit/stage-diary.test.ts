import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"

function taskDir(projectDir: string, name = "task-123"): string {
  const td = path.join(projectDir, ".kody", "tasks", name)
  fs.mkdirSync(td, { recursive: true })
  return td
}

function makeCtx(
  projectDir: string,
  runOutput: string,
  outcome: AgentResult["outcome"] = "completed",
): { ctx: PipelineContext; runner: AgentRunner } {
  const runner: AgentRunner = {
    async run(): Promise<AgentResult> {
      return { outcome, output: runOutput }
    },
    async healthCheck() {
      return true
    },
  }
  const ctx: PipelineContext = {
    taskId: "1244-260417-120000",
    taskDir: taskDir(projectDir),
    projectDir,
    runners: { claude: runner },
    input: { mode: "full" },
  }
  return { ctx, runner }
}

// `resolveModel` reads config and would throw without a kody.config.json.
// Stub it so the distiller can run purely off the mock runner.
vi.mock("../../src/context.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, resolveModel: () => "claude-haiku-4-5" }
})
vi.mock("../../src/config.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    getProjectConfig: () => ({ agent: { defaultRunner: "claude", modelMap: {} } }),
    anyStageNeedsProxy: () => false,
    getLitellmUrl: () => "",
  }
})

describe("distillStageInsights", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diary-test-"))
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("parses a valid LLM JSON response into insights", async () => {
    const { distillStageInsights } = await import("../../src/stage-diary.js")
    const { ctx } = makeCtx(
      projectDir,
      JSON.stringify({
        insights: [
          {
            kind: "gotcha",
            text: "mcp-api-key users lack a role field; guard user.collection first.",
            scope: "auth",
          },
          { kind: "convention", text: "Use AccountRole constants instead of string literals." },
        ],
      }),
    )
    fs.writeFileSync(path.join(ctx.taskDir, "task.md"), "Add Instructor role")
    fs.writeFileSync(path.join(ctx.taskDir, "plan.md"), "Add CourseInstructors collection")
    fs.writeFileSync(path.join(ctx.taskDir, "context.md"), "src/infra/auth/roles.ts")

    const insights = await distillStageInsights("build", ctx)
    expect(insights).toHaveLength(2)
    expect(insights[0].kind).toBe("gotcha")
    expect(insights[0].scope).toBe("auth")
    expect(insights[1].kind).toBe("convention")
  })

  it("returns [] when the LLM output is malformed", async () => {
    const { distillStageInsights } = await import("../../src/stage-diary.js")
    const { ctx } = makeCtx(projectDir, "not json at all")
    fs.writeFileSync(path.join(ctx.taskDir, "task.md"), "X")
    fs.writeFileSync(path.join(ctx.taskDir, "plan.md"), "Y")

    const insights = await distillStageInsights("build", ctx)
    expect(insights).toEqual([])
  })

  it("returns [] when the runner reports failure", async () => {
    const { distillStageInsights } = await import("../../src/stage-diary.js")
    const { ctx } = makeCtx(projectDir, "", "failed")
    fs.writeFileSync(path.join(ctx.taskDir, "task.md"), "X")
    fs.writeFileSync(path.join(ctx.taskDir, "plan.md"), "Y")

    const insights = await distillStageInsights("build", ctx)
    expect(insights).toEqual([])
  })

  it("returns [] when no artifacts exist (nothing to distill from)", async () => {
    const { distillStageInsights } = await import("../../src/stage-diary.js")
    const { ctx } = makeCtx(projectDir, "{\"insights\":[]}")
    const insights = await distillStageInsights("build", ctx)
    expect(insights).toEqual([])
  })

  it("is a no-op for unknown stages", async () => {
    const { distillStageInsights } = await import("../../src/stage-diary.js")
    const { ctx } = makeCtx(
      projectDir,
      JSON.stringify({ insights: [{ kind: "lesson", text: "x" }] }),
    )
    const insights = await distillStageInsights("ship", ctx)
    expect(insights).toEqual([])
  })

  it("drops insights with invalid kind and empty text; caps at 5", async () => {
    const { distillStageInsights } = await import("../../src/stage-diary.js")
    const payload = {
      insights: [
        { kind: "bogus", text: "ignored" },
        { kind: "lesson", text: "" },
        { kind: "lesson", text: "keep 1" },
        { kind: "gotcha", text: "keep 2" },
        { kind: "convention", text: "keep 3" },
        { kind: "decision", text: "keep 4" },
        { kind: "lesson", text: "keep 5" },
        { kind: "lesson", text: "over the cap" },
      ],
    }
    const { ctx } = makeCtx(projectDir, JSON.stringify(payload))
    fs.writeFileSync(path.join(ctx.taskDir, "task.md"), "X")
    fs.writeFileSync(path.join(ctx.taskDir, "plan.md"), "Y")

    const insights = await distillStageInsights("build", ctx)
    expect(insights).toHaveLength(5)
    expect(insights.every((i) => i.text.startsWith("keep"))).toBe(true)
  })

  it("truncates text over 200 chars", async () => {
    const { distillStageInsights } = await import("../../src/stage-diary.js")
    const longText = "x".repeat(500)
    const { ctx } = makeCtx(
      projectDir,
      JSON.stringify({ insights: [{ kind: "lesson", text: longText }] }),
    )
    fs.writeFileSync(path.join(ctx.taskDir, "task.md"), "X")
    fs.writeFileSync(path.join(ctx.taskDir, "plan.md"), "Y")

    const insights = await distillStageInsights("build", ctx)
    expect(insights).toHaveLength(1)
    expect(insights[0].text.length).toBe(200)
  })
})

describe("appendStageInsights + readStageInsights", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diary-test-"))
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  function baseCtx(): PipelineContext {
    const runner: AgentRunner = {
      async run() {
        return { outcome: "completed", output: "" } as AgentResult
      },
      async healthCheck() {
        return true
      },
    }
    return {
      taskId: "1244-260417-120000",
      taskDir: taskDir(projectDir),
      projectDir,
      runners: { claude: runner },
      input: { mode: "full" },
    }
  }

  it("writes one episode and one node per new insight, tagged with stage", async () => {
    const { appendStageInsights, readStageInsights } = await import(
      "../../src/stage-diary.js"
    )
    const ctx = baseCtx()

    appendStageInsights(ctx, "review", [
      { kind: "gotcha", text: "Guard user.collection before accessing user.role.", scope: "auth" },
      { kind: "convention", text: "Use AccountRole enum, not string literals.", scope: "auth" },
    ])

    const rows = readStageInsights(projectDir, "review")
    expect(rows).toHaveLength(2)
    const kinds = rows.map((r) => r.insight.kind).sort()
    expect(kinds).toEqual(["convention", "gotcha"])
    expect(rows.every((r) => r.taskId === ctx.taskId)).toBe(true)
  })

  it("skips a duplicate insight on a second write (novelty gate, same text)", async () => {
    const { appendStageInsights, readStageInsights } = await import(
      "../../src/stage-diary.js"
    )
    const ctx = baseCtx()

    appendStageInsights(ctx, "review", [
      { kind: "gotcha", text: "Guard user.collection before user.role.", scope: "auth" },
    ])
    appendStageInsights(ctx, "review", [
      { kind: "gotcha", text: "  GUARD user.collection before user.role!! ", scope: "auth" },
    ])

    const rows = readStageInsights(projectDir, "review", 50)
    expect(rows).toHaveLength(1)
  })

  it("skips a near-duplicate paraphrase (Jaccard similarity)", async () => {
    const { appendStageInsights, readStageInsights } = await import(
      "../../src/stage-diary.js"
    )
    const ctx = baseCtx()

    appendStageInsights(ctx, "review", [
      {
        kind: "gotcha",
        text: "mcp-api-key users lack 'role' property; auth hooks must guard user.collection !== 'users' before accessing user.role",
        scope: "auth",
      },
    ])
    // Paraphrase with different wording and a different room — same idea
    appendStageInsights(ctx, "review", [
      {
        kind: "gotcha",
        text: "mcp-api-key users lack a 'role' property; guard user.collection before accessing user.role in access-control hooks to prevent undefined errors",
        scope: "auth/access-control",
      },
    ])

    const rows = readStageInsights(projectDir, "review", 50)
    expect(rows).toHaveLength(1)
  })

  it("does NOT dedup genuinely distinct insights in the same hall", async () => {
    const { appendStageInsights, readStageInsights } = await import(
      "../../src/stage-diary.js"
    )
    const ctx = baseCtx()

    appendStageInsights(ctx, "review", [
      {
        kind: "gotcha",
        text: "mcp-api-key users lack a role property; guard user.collection first",
        scope: "auth",
      },
      {
        kind: "gotcha",
        text: "i18n translation keys are easy to forget when adding a new dashboard",
        scope: "i18n",
      },
    ])

    const rows = readStageInsights(projectDir, "review", 50)
    expect(rows).toHaveLength(2)
  })

  it("returns rows newest first and respects the limit", async () => {
    const { appendStageInsights, readStageInsights } = await import(
      "../../src/stage-diary.js"
    )
    const ctx = baseCtx()

    // Space writes across distinct milliseconds so validFrom sorts deterministically.
    for (let i = 0; i < 5; i++) {
      appendStageInsights(ctx, "build", [
        { kind: "lesson", text: `lesson ${i}` },
      ])
      await new Promise((r) => setTimeout(r, 3))
    }

    const rows = readStageInsights(projectDir, "build", 3)
    expect(rows).toHaveLength(3)
    expect(rows[0].insight.text).toBe("lesson 4")
    expect(rows[1].insight.text).toBe("lesson 3")
    expect(rows[2].insight.text).toBe("lesson 2")
  })

  it("filters by stage tag — does not leak across stages", async () => {
    const { appendStageInsights, readStageInsights } = await import(
      "../../src/stage-diary.js"
    )
    const ctx = baseCtx()

    appendStageInsights(ctx, "review", [{ kind: "gotcha", text: "review insight" }])
    appendStageInsights(ctx, "build", [{ kind: "lesson", text: "build insight" }])

    expect(readStageInsights(projectDir, "review").map((r) => r.insight.text)).toEqual([
      "review insight",
    ])
    expect(readStageInsights(projectDir, "build").map((r) => r.insight.text)).toEqual([
      "build insight",
    ])
  })

  it("no-op when given an empty insight list", async () => {
    const { appendStageInsights, readStageInsights } = await import(
      "../../src/stage-diary.js"
    )
    const ctx = baseCtx()
    appendStageInsights(ctx, "review", [])
    expect(readStageInsights(projectDir, "review")).toEqual([])
  })
})

describe("formatStageInsightsForPrompt", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diary-test-"))
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns empty string with no insights", async () => {
    const { formatStageInsightsForPrompt } = await import("../../src/stage-diary.js")
    expect(formatStageInsightsForPrompt("review", [])).toBe("")
  })

  it("renders a markdown block with kind, scope, text, task, and date", async () => {
    const { formatStageInsightsForPrompt } = await import("../../src/stage-diary.js")
    const out = formatStageInsightsForPrompt("review", [
      {
        insight: { kind: "gotcha", text: "Guard user.collection first.", scope: "auth" },
        taskId: "1244-260417-120000",
        timestamp: "2026-04-17T06:25:46.000Z",
      },
    ])
    expect(out).toContain("## Stage diary — review (1 recent insight)")
    expect(out).toContain("gotcha [auth]: Guard user.collection first.")
    // taskId is truncated to 12 chars for the annotation
    expect(out).toContain("task 1244-260417-")
    expect(out).toContain("2026-04-17")
  })
})

describe("cleanupLegacyDiaryFiles", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diary-test-"))
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("removes diary_*.jsonl files but leaves other files alone", async () => {
    const { cleanupLegacyDiaryFiles } = await import("../../src/stage-diary.js")

    const memDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "diary_review.jsonl"), "{}\n")
    fs.writeFileSync(path.join(memDir, "diary_build.jsonl"), "{}\n")
    fs.writeFileSync(path.join(memDir, "conventions.md"), "keep me")

    cleanupLegacyDiaryFiles(projectDir)

    expect(fs.existsSync(path.join(memDir, "diary_review.jsonl"))).toBe(false)
    expect(fs.existsSync(path.join(memDir, "diary_build.jsonl"))).toBe(false)
    expect(fs.existsSync(path.join(memDir, "conventions.md"))).toBe(true)
  })

  it("is a no-op when the memory directory doesn't exist", async () => {
    const { cleanupLegacyDiaryFiles } = await import("../../src/stage-diary.js")
    expect(() => cleanupLegacyDiaryFiles(projectDir)).not.toThrow()
  })
})
