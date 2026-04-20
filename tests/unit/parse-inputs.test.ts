import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { parseCommentInputs, type ParseResult } from "../../src/ci/parse-inputs.js"

/**
 * Unit tests for the TypeScript comment parser (parseCommentInputs).
 * Covers all modes, flags, body extraction, PR detection, and task-id generation.
 */

describe("parseCommentInputs", () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    // Defaults for comment trigger
    process.env.TRIGGER_TYPE = "comment"
    process.env.ISSUE_NUMBER = "42"
    process.env.ISSUE_IS_PR = ""
    process.env.COMMENT_BODY = ""
  })

  afterEach(() => {
    process.env = originalEnv
  })

  // ─── Basic modes ──────────────────────────────────────────────────────────

  it("bare @kody defaults to full mode", () => {
    process.env.COMMENT_BODY = "@kody"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.valid).toBe(true)
  })

  it("parses @kody full", () => {
    process.env.COMMENT_BODY = "@kody full"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.valid).toBe(true)
  })

  it("parses @kody rerun", () => {
    process.env.COMMENT_BODY = "@kody rerun"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
  })

  it("parses @kody status", () => {
    process.env.COMMENT_BODY = "@kody status"
    const r = parseCommentInputs()
    expect(r.mode).toBe("status")
  })

  it("parses @kody fix", () => {
    process.env.COMMENT_BODY = "@kody fix"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix")
  })

  it("parses @kody fix-ci", () => {
    process.env.COMMENT_BODY = "@kody fix-ci"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix-ci")
  })

  it("parses @kody review", () => {
    process.env.COMMENT_BODY = "@kody review"
    const r = parseCommentInputs()
    expect(r.mode).toBe("review")
  })

  it("parses @kody resolve", () => {
    process.env.COMMENT_BODY = "@kody resolve"
    const r = parseCommentInputs()
    expect(r.mode).toBe("resolve")
  })

  it("parses @kody bootstrap", () => {
    process.env.COMMENT_BODY = "@kody bootstrap"
    const r = parseCommentInputs()
    expect(r.mode).toBe("bootstrap")
    expect(r.task_id).toMatch(/^bootstrap-\d{6}-\d{6}$/)
  })

  it("parses @kody approve", () => {
    process.env.COMMENT_BODY = "@kody approve"
    const r = parseCommentInputs()
    // approve converts to rerun
    expect(r.mode).toBe("rerun")
  })

  // ─── Model flag (provider/model) ──────────────────────────────────────────

  it("parses --model flag", () => {
    process.env.COMMENT_BODY = "@kody fix --model claude/claude-sonnet-4-6"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix")
    expect(r.model).toBe("claude/claude-sonnet-4-6")
  })

  it("parses --model with other flags", () => {
    process.env.COMMENT_BODY = "@kody rerun task-123 --from build --model minimax/MiniMax-M2.7-highspeed"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.task_id).toBe("task-123")
    expect(r.from_stage).toBe("build")
    expect(r.model).toBe("minimax/MiniMax-M2.7-highspeed")
  })

  it("parses --model=value (equals syntax)", () => {
    process.env.COMMENT_BODY = "@kody fix --model=claude/claude-opus-4-6"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix")
    expect(r.model).toBe("claude/claude-opus-4-6")
  })

  it("parses mixed equals and space syntax", () => {
    process.env.COMMENT_BODY = "@kody rerun task-1 --from=build --model=claude/claude-sonnet-4-6"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.task_id).toBe("task-1")
    expect(r.from_stage).toBe("build")
    expect(r.model).toBe("claude/claude-sonnet-4-6")
  })

  it("--model does not pollute task-id", () => {
    process.env.COMMENT_BODY = "@kody full --model openai/gpt-4o"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.model).toBe("openai/gpt-4o")
    // task_id should be auto-generated, not "openai/gpt-4o"
    expect(r.task_id).toMatch(/^42-\d{6}-\d{6}$/)
  })

  // ─── Flags ────────────────────────────────────────────────────────────────

  it("parses --from flag", () => {
    process.env.COMMENT_BODY = "@kody rerun 226-260401-063126 --from verify"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.task_id).toBe("226-260401-063126")
    expect(r.from_stage).toBe("verify")
  })

  it("parses --feedback with quoted text", () => {
    process.env.COMMENT_BODY = '@kody full --feedback "Use functional style"'
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.feedback).toBe("Use functional style")
  })

  it("parses --complexity flag", () => {
    process.env.COMMENT_BODY = "@kody full --complexity high"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.complexity).toBe("high")
  })

  it("parses --complexity=value (equals syntax)", () => {
    process.env.COMMENT_BODY = "@kody full --complexity=high"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.complexity).toBe("high")
  })

  it("parses --dry-run flag", () => {
    process.env.COMMENT_BODY = "@kody full --dry-run"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.dry_run).toBe(true)
  })

  it("parses --ci-run-id flag", () => {
    process.env.COMMENT_BODY = "@kody fix-ci --ci-run-id 123456"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix-ci")
    expect(r.ci_run_id).toBe("123456")
  })

  it("parses multiple flags together", () => {
    process.env.COMMENT_BODY = '@kody full --complexity medium --feedback "Be concise" --dry-run'
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.complexity).toBe("medium")
    expect(r.feedback).toBe("Be concise")
    expect(r.dry_run).toBe(true)
  })

  // ─── Approve mode → rerun with body as feedback ──────────────────────────

  it("approve mode converts to rerun with body as feedback", () => {
    process.env.COMMENT_BODY = "@kody approve\nYes, looks good\nPlease proceed"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.feedback).toBe("Yes, looks good\nPlease proceed")
  })

  it("approve with inline text treats it as feedback, not task-id", () => {
    process.env.COMMENT_BODY = "@kody approve acceptable"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.task_id).toBe("")
    expect(r.feedback).toBe("acceptable")
  })

  it("approve with inline text and body combines both as feedback", () => {
    process.env.COMMENT_BODY = "@kody approve looks good\nPlease use the retry approach"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.task_id).toBe("")
    expect(r.feedback).toBe("looks good\nPlease use the retry approach")
  })

  it("bare approve with no text has empty feedback and task-id", () => {
    process.env.COMMENT_BODY = "@kody approve"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.task_id).toBe("")
    expect(r.feedback).toBe("")
  })

  // ─── Fix mode extracts body as feedback ───────────────────────────────────

  it("fix mode extracts body as feedback", () => {
    process.env.COMMENT_BODY = "@kody fix\nThe button color should be blue"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix")
    expect(r.feedback).toBe("The button color should be blue")
  })

  it("fix mode with empty body has empty feedback", () => {
    process.env.COMMENT_BODY = "@kody fix"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix")
    expect(r.feedback).toBe("")
  })

  // ─── Fix-ci mode extracts body as feedback + ci-run-id ────────────────────

  it("fix-ci mode extracts body as feedback and run id", () => {
    process.env.COMMENT_BODY = "@kody fix-ci\nCI failed: View logs\nRun ID: 789012"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix-ci")
    expect(r.feedback).toBe("CI failed: View logs\nRun ID: 789012")
    expect(r.ci_run_id).toBe("789012")
  })

  // ─── Default full mode edge cases ────────────────────────────────────────

  it("@kody --complexity low (flag without mode) defaults to full", () => {
    process.env.COMMENT_BODY = "@kody --complexity low"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.complexity).toBe("low")
  })

  it("@kody my-task-123 (unknown word) treats as task-id with full mode", () => {
    process.env.COMMENT_BODY = "@kody my-task-123"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.task_id).toBe("my-task-123")
  })

  // ─── /kody prefix works same as @kody ─────────────────────────────────────

  it("/kody prefix works same as @kody", () => {
    process.env.COMMENT_BODY = "/kody --complexity low"
    const r = parseCommentInputs()
    expect(r.mode).toBe("full")
    expect(r.complexity).toBe("low")
  })

  it("/kody review works", () => {
    process.env.COMMENT_BODY = "/kody review"
    const r = parseCommentInputs()
    expect(r.mode).toBe("review")
  })

  // ─── PR detection: ISSUE_IS_PR env ────────────────────────────────────────

  it("sets pr_number when ISSUE_IS_PR is set", () => {
    process.env.COMMENT_BODY = "@kody review"
    process.env.ISSUE_IS_PR = "true"
    process.env.ISSUE_NUMBER = "99"
    const r = parseCommentInputs()
    expect(r.pr_number).toBe("99")
  })

  it("pr_number is empty when ISSUE_IS_PR is not set", () => {
    process.env.COMMENT_BODY = "@kody review"
    process.env.ISSUE_IS_PR = ""
    const r = parseCommentInputs()
    expect(r.pr_number).toBe("")
  })

  // ─── Review on PR: task-id = review-pr-<pr>-<timestamp> ──────────────────

  it("review on PR generates review-pr task-id", () => {
    process.env.COMMENT_BODY = "@kody review"
    process.env.ISSUE_IS_PR = "true"
    process.env.ISSUE_NUMBER = "55"
    const r = parseCommentInputs()
    expect(r.mode).toBe("review")
    expect(r.task_id).toMatch(/^review-pr-55-\d{6}-\d{6}$/)
    expect(r.pr_number).toBe("55")
  })

  // ─── Task-id auto-generation for full mode: <issue>-<timestamp> ──────────

  it("auto-generates task-id for full mode when not provided", () => {
    process.env.COMMENT_BODY = "@kody full"
    process.env.ISSUE_NUMBER = "42"
    const r = parseCommentInputs()
    expect(r.task_id).toMatch(/^42-\d{6}-\d{6}$/)
  })

  it("does not auto-generate task-id when one is provided", () => {
    process.env.COMMENT_BODY = "@kody full my-task-456"
    const r = parseCommentInputs()
    expect(r.task_id).toBe("my-task-456")
  })

  // ─── rerun --from with no task-id ─────────────────────────────────────────

  it("parses @kody rerun --from build (no task-id)", () => {
    process.env.COMMENT_BODY = "@kody rerun --from build"
    const r = parseCommentInputs()
    expect(r.mode).toBe("rerun")
    expect(r.task_id).toBe("")
    expect(r.from_stage).toBe("build")
  })

  // ─── Non-kody comment returns invalid ─────────────────────────────────────

  it("non-kody comment returns valid=false", () => {
    process.env.COMMENT_BODY = "Hello world"
    const r = parseCommentInputs()
    expect(r.valid).toBe(false)
  })

  // ─── Prefix collision guard: @kody2, @kodyx, etc. must not trigger ────────

  it("@kody2 does not trigger (prefix collision guard)", () => {
    process.env.COMMENT_BODY = "@kody2 full"
    const r = parseCommentInputs()
    expect(r.valid).toBe(false)
  })

  it("@kodyx does not trigger", () => {
    process.env.COMMENT_BODY = "@kodyx review"
    const r = parseCommentInputs()
    expect(r.valid).toBe(false)
  })

  it("/kody2 does not trigger", () => {
    process.env.COMMENT_BODY = "/kody2 fix"
    const r = parseCommentInputs()
    expect(r.valid).toBe(false)
  })

  it("@kody followed by punctuation still triggers", () => {
    process.env.COMMENT_BODY = "@kody: full"
    const r = parseCommentInputs()
    expect(r.valid).toBe(true)
    expect(r.mode).toBe("full")
  })

  it("@kody2 in same body as @kody picks the @kody line", () => {
    process.env.COMMENT_BODY = "@kody2 something\n@kody fix\nfeedback here"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix")
    expect(r.feedback).toBe("feedback here")
  })

  // ─── Dispatch trigger passthrough ─────────────────────────────────────────

  it("dispatch trigger passes through inputs", () => {
    process.env.TRIGGER_TYPE = "dispatch"
    process.env.INPUT_TASK_ID = "dispatch-task"
    process.env.INPUT_MODE = "rerun"
    process.env.INPUT_FROM_STAGE = "build"
    process.env.INPUT_ISSUE_NUMBER = "10"
    process.env.INPUT_FEEDBACK = "some feedback"
    const r = parseCommentInputs()
    expect(r.task_id).toBe("dispatch-task")
    expect(r.mode).toBe("rerun")
    expect(r.from_stage).toBe("build")
    expect(r.issue_number).toBe("10")
    expect(r.feedback).toBe("some feedback")
    expect(r.trigger_type).toBe("dispatch")
    expect(r.valid).toBe(true)
  })

  it("dispatch trigger passes through model", () => {
    process.env.TRIGGER_TYPE = "dispatch"
    process.env.INPUT_TASK_ID = "dispatch-task"
    process.env.INPUT_MODEL = "openai/gpt-4o"
    const r = parseCommentInputs()
    expect(r.model).toBe("openai/gpt-4o")
  })

  it("dispatch trigger with no task_id is invalid", () => {
    process.env.TRIGGER_TYPE = "dispatch"
    process.env.INPUT_TASK_ID = ""
    const r = parseCommentInputs()
    expect(r.valid).toBe(false)
  })

  // ─── Carriage return stripping ────────────────────────────────────────────

  it("strips carriage returns from comment body", () => {
    process.env.COMMENT_BODY = "@kody fix\r\nFix the button\r\nPlease"
    const r = parseCommentInputs()
    expect(r.mode).toBe("fix")
    expect(r.feedback).toBe("Fix the button\nPlease")
  })

  // ─── Issue number passthrough ─────────────────────────────────────────────

  it("passes issue_number from env", () => {
    process.env.COMMENT_BODY = "@kody full"
    process.env.ISSUE_NUMBER = "77"
    const r = parseCommentInputs()
    expect(r.issue_number).toBe("77")
  })

  // ─── Ask mode ──────────────────────────────────────────────────────────────

  it("parses @kody ask", () => {
    process.env.COMMENT_BODY = "@kody ask"
    const r = parseCommentInputs()
    expect(r.mode).toBe("ask")
    expect(r.valid).toBe(true)
    expect(r.task_id).toMatch(/^ask-42-\d{6}-\d{6}$/)
  })

  it("ask mode extracts body as feedback (the question)", () => {
    process.env.COMMENT_BODY = "@kody ask\nWhat testing framework does this project use?"
    const r = parseCommentInputs()
    expect(r.mode).toBe("ask")
    expect(r.feedback).toBe("What testing framework does this project use?")
  })

  it("ask mode extracts multiline body as feedback", () => {
    process.env.COMMENT_BODY = "@kody ask\nHow does auth work?\nWhat patterns does it use?"
    const r = parseCommentInputs()
    expect(r.mode).toBe("ask")
    expect(r.feedback).toBe("How does auth work?\nWhat patterns does it use?")
  })

  it("ask mode auto-generates task-id", () => {
    process.env.COMMENT_BODY = "@kody ask\nSome question"
    process.env.ISSUE_NUMBER = "99"
    const r = parseCommentInputs()
    expect(r.task_id).toMatch(/^ask-99-\d{6}-\d{6}$/)
  })

  it("/kody ask works same as @kody ask", () => {
    process.env.COMMENT_BODY = "/kody ask\nWhat is this?"
    const r = parseCommentInputs()
    expect(r.mode).toBe("ask")
    expect(r.feedback).toBe("What is this?")
  })

  // ─── Hotfix mode ────────────────────────────────────────────────────────

  it("parses @kody hotfix", () => {
    process.env.COMMENT_BODY = "@kody hotfix"
    const r = parseCommentInputs()
    expect(r.mode).toBe("hotfix")
    expect(r.valid).toBe(true)
    expect(r.task_id).toMatch(/^hotfix-42-\d{6}-\d{6}$/)
  })

  it("hotfix with --dry-run", () => {
    process.env.COMMENT_BODY = "@kody hotfix --dry-run"
    const r = parseCommentInputs()
    expect(r.mode).toBe("hotfix")
    expect(r.dry_run).toBe(true)
  })

  it("/kody hotfix works same as @kody hotfix", () => {
    process.env.COMMENT_BODY = "/kody hotfix"
    const r = parseCommentInputs()
    expect(r.mode).toBe("hotfix")
    expect(r.valid).toBe(true)
  })

  // ─── Revert mode ───────────────────────────────────────────────────────

  it("parses @kody revert #87", () => {
    process.env.COMMENT_BODY = "@kody revert #87"
    const r = parseCommentInputs()
    expect(r.mode).toBe("revert")
    expect(r.revert_target).toBe("87")
    expect(r.valid).toBe(true)
    expect(r.task_id).toMatch(/^revert-\d{6}-\d{6}$/)
  })

  it("parses @kody revert 87 (no hash)", () => {
    process.env.COMMENT_BODY = "@kody revert 87"
    const r = parseCommentInputs()
    expect(r.mode).toBe("revert")
    expect(r.revert_target).toBe("87")
  })

  it("parses @kody revert (no target)", () => {
    process.env.COMMENT_BODY = "@kody revert"
    const r = parseCommentInputs()
    expect(r.mode).toBe("revert")
    expect(r.revert_target).toBe("")
    expect(r.valid).toBe(true)
  })

  it("revert with --dry-run", () => {
    process.env.COMMENT_BODY = "@kody revert #42 --dry-run"
    const r = parseCommentInputs()
    expect(r.mode).toBe("revert")
    expect(r.revert_target).toBe("42")
    expect(r.dry_run).toBe(true)
  })

  it("/kody revert works same as @kody revert", () => {
    process.env.COMMENT_BODY = "/kody revert #10"
    const r = parseCommentInputs()
    expect(r.mode).toBe("revert")
    expect(r.revert_target).toBe("10")
  })

  // ─── Decompose task-id generation ───────────────────────────────────────

  it("@kody decompose generates unique task-id (not bare 'decompose')", () => {
    process.env.COMMENT_BODY = "@kody decompose"
    process.env.ISSUE_NUMBER = "42"
    const r = parseCommentInputs()
    expect(r.task_id).toMatch(/^decompose-42-\d{6}-\d{6}$/)
    expect(r.task_id).not.toBe("decompose")
  })

  it("@kody decompose --no-compose generates unique task-id", () => {
    process.env.COMMENT_BODY = "@kody decompose --no-compose"
    process.env.ISSUE_NUMBER = "55"
    const r = parseCommentInputs()
    expect(r.task_id).toMatch(/^decompose-55-\d{6}-\d{6}$/)
  })
})
