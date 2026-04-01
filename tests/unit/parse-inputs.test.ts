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
})
