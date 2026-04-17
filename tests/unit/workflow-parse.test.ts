import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { parseCommentInputs } from "../../src/ci/parse-inputs.js"

/**
 * Tests the comment parsing logic from src/ci/parse-inputs.ts.
 * Sets TRIGGER_TYPE=comment and COMMENT_BODY to simulate GitHub Actions.
 */
function parseComment(body: string): Record<string, string> {
  process.env.TRIGGER_TYPE = "comment"
  process.env.COMMENT_BODY = body
  process.env.ISSUE_NUMBER = "42"
  process.env.ISSUE_IS_PR = ""

  const result = parseCommentInputs()
  return {
    MODE: result.mode,
    TASK_ID: result.task_id,
    FROM_STAGE: result.from_stage,
    FEEDBACK: result.feedback,
    COMPLEXITY: result.complexity,
    MODEL: result.model,
    DRY_RUN: result.dry_run ? "true" : "false",
  }
}

describe("workflow parse step", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ["TRIGGER_TYPE", "COMMENT_BODY", "ISSUE_NUMBER", "ISSUE_IS_PR"]) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it("parses bare @kody", () => {
    const r = parseComment("@kody")
    expect(r.MODE).toBe("full")
  })

  it("parses @kody full", () => {
    const r = parseComment("@kody full")
    expect(r.MODE).toBe("full")
  })

  it("parses @kody rerun with task-id and --from", () => {
    const r = parseComment("@kody rerun 226-260401-063126 --from verify")
    expect(r.MODE).toBe("rerun")
    expect(r.TASK_ID).toBe("226-260401-063126")
    expect(r.FROM_STAGE).toBe("verify")
  })

  it("parses @kody --complexity low (flag-only command)", () => {
    const r = parseComment("@kody --complexity low")
    expect(r.MODE).toBe("full")
    expect(r.COMPLEXITY).toBe("low")
  })

  it("parses @kody full --complexity high", () => {
    const r = parseComment("@kody full --complexity high")
    expect(r.MODE).toBe("full")
    expect(r.COMPLEXITY).toBe("high")
  })

  it("parses @kody --feedback with quoted text", () => {
    const r = parseComment('@kody --feedback "Use functional style"')
    expect(r.MODE).toBe("full")
    expect(r.FEEDBACK).toBe("Use functional style")
  })

  it("parses @kody full --dry-run", () => {
    const r = parseComment("@kody full --dry-run")
    expect(r.MODE).toBe("full")
    expect(r.DRY_RUN).toBe("true")
  })

  it("parses @kody fix", () => {
    const r = parseComment("@kody fix")
    expect(r.MODE).toBe("fix")
  })

  it("parses @kody review", () => {
    const r = parseComment("@kody review")
    expect(r.MODE).toBe("review")
  })

  it("parses @kody resolve", () => {
    const r = parseComment("@kody resolve")
    expect(r.MODE).toBe("resolve")
  })

  it("parses @kody status", () => {
    const r = parseComment("@kody status")
    expect(r.MODE).toBe("status")
  })

  it("parses @kody with multiple flags", () => {
    const r = parseComment('@kody full --complexity medium --feedback "Be concise" --dry-run')
    expect(r.MODE).toBe("full")
    expect(r.COMPLEXITY).toBe("medium")
    expect(r.FEEDBACK).toBe("Be concise")
    expect(r.DRY_RUN).toBe("true")
  })

  it("parses @kody rerun --from build (no task-id)", () => {
    const r = parseComment("@kody rerun --from build")
    expect(r.MODE).toBe("rerun")
    expect(r.TASK_ID).toBe("")
    expect(r.FROM_STAGE).toBe("build")
  })

  it("parses --model 'provider/model' flag", () => {
    const r = parseComment("@kody fix --model anthropic/claude-sonnet-4-6")
    expect(r.MODE).toBe("fix")
    expect(r.MODEL).toBe("anthropic/claude-sonnet-4-6")
  })

  it("parses --model alone", () => {
    const r = parseComment("@kody full --model minimax/MiniMax-M2.7-highspeed")
    expect(r.MODE).toBe("full")
    expect(r.MODEL).toBe("minimax/MiniMax-M2.7-highspeed")
  })

  it("parses --model with other flags", () => {
    const r = parseComment("@kody full --complexity high --model minimax/MiniMax-M2.7-highspeed --dry-run")
    expect(r.MODE).toBe("full")
    expect(r.COMPLEXITY).toBe("high")
    expect(r.MODEL).toBe("minimax/MiniMax-M2.7-highspeed")
    expect(r.DRY_RUN).toBe("true")
  })

  it("parses --model=value equals syntax", () => {
    const r = parseComment("@kody fix --model=claude/claude-opus-4-6")
    expect(r.MODE).toBe("fix")
    expect(r.MODEL).toBe("claude/claude-opus-4-6")
  })

  it("treats unknown first positional as task-id", () => {
    const r = parseComment("@kody my-task-123")
    expect(r.MODE).toBe("full")
    expect(r.TASK_ID).toBe("my-task-123")
  })

  it("parses /kody prefix", () => {
    const r = parseComment("/kody --complexity low")
    expect(r.MODE).toBe("full")
    expect(r.COMPLEXITY).toBe("low")
  })
})
