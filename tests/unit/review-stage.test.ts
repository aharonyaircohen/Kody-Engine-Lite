import { describe, it, expect, vi, beforeEach } from "vitest"
import type { PipelineContext } from "../../src/types.js"
import { detectReviewVerdict, formatReviewComment } from "../../src/review-standalone.js"

// ─── Mock dependencies (hoisted — factories run before any outer-scope vars exist) ─

vi.mock("../../src/github-api.js", () => ({
  postPRComment: vi.fn(),
  postComment: vi.fn(),
  getPRDetails: vi.fn(),
  submitPRReview: vi.fn(),
}))

vi.mock("../../src/memory/graph/index.js", () => ({
  createEpisode: vi.fn(() => ({ id: "ep1" })),
  inferRoom: vi.fn(() => "default"),
  writeFactOnce: vi.fn(() => ({ id: "fact1" })),
}))

vi.mock("../../src/stages/agent.js", () => ({
  executeAgentStage: vi.fn(),
}))

// Mock fs to provide review.md content
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "## Verdict: PASS\n\nNo issues."),
  readdirSync: vi.fn(() => []),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

import { executeReviewWithFix } from "../../src/stages/review.js"
import { postPRComment } from "../../src/github-api.js"
import { executeAgentStage } from "../../src/stages/agent.js"
import * as fs from "fs"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REVIEW_PASS = "## Verdict: PASS\n\nNo issues."
const REVIEW_FAIL = "## Verdict: FAIL\n\n### Critical\nSomething broken."

function makeCtx(prNumber?: number, local = false): PipelineContext {
  return {
    taskId: "review-test",
    taskDir: "/tmp/kody-review-test",
    projectDir: "/tmp",
    runners: {},
    input: {
      mode: "full" as const,
      prNumber,
      local,
    },
  } as unknown as PipelineContext
}

function makeReviewDef() {
  return { name: "review", type: "agent" as const, modelTier: "mid" as const, timeout: 60_000, maxRetries: 1 }
}

function makeCompletedReviewResult(output = REVIEW_PASS) {
  return { outcome: "completed" as const, output }
}

// ─── executeReviewWithFix tests ──────────────────────────────────────────────

describe("executeReviewWithFix", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: stage succeeds, review.md contains PASS verdict
    ;(executeAgentStage as ReturnType<typeof vi.fn>).mockResolvedValue(makeCompletedReviewResult())
    ;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(REVIEW_PASS)
  })

  it("posts review to PR when prNumber is set and not local", async () => {
    const ctx = makeCtx(1181, false)

    await executeReviewWithFix(ctx, makeReviewDef())

    expect(postPRComment).toHaveBeenCalledTimes(1)
    expect(postPRComment).toHaveBeenCalledWith(
      1181,
      expect.stringContaining("## Verdict: PASS"),
    )
  })

  it("does not post review when prNumber is absent", async () => {
    const ctx = makeCtx(undefined, false)

    await executeReviewWithFix(ctx, makeReviewDef())

    expect(postPRComment).not.toHaveBeenCalled()
  })

  it("does not post review when local mode is true", async () => {
    const ctx = makeCtx(1181, true)

    await executeReviewWithFix(ctx, makeReviewDef())

    expect(postPRComment).not.toHaveBeenCalled()
  })

  it("includes task ID in the posted comment", async () => {
    const ctx = makeCtx(9999, false)

    await executeReviewWithFix(ctx, makeReviewDef())

    const postedComment = vi.mocked(postPRComment).mock.calls[0][1]
    expect(postedComment).toContain(ctx.taskId)
  })

  it("returns completed when review stage completes", async () => {
    const ctx = makeCtx(1181, false)

    const result = await executeReviewWithFix(ctx, makeReviewDef())

    expect(result.outcome).toBe("completed")
    expect(executeAgentStage).toHaveBeenCalled()
  })

  it("returns failed when review stage fails", async () => {
    ;(executeAgentStage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ outcome: "failed" as const, error: "Model unavailable" })
    const ctx = makeCtx(1181, false)

    const result = await executeReviewWithFix(ctx, makeReviewDef())

    expect(result.outcome).toBe("failed")
    expect(postPRComment).not.toHaveBeenCalled()
  })

  it("skips posting on dry-run", async () => {
    const ctx = makeCtx(1181, false)
    ctx.input.dryRun = true

    await executeReviewWithFix(ctx, makeReviewDef())

    expect(executeAgentStage).not.toHaveBeenCalled()
    expect(postPRComment).not.toHaveBeenCalled()
  })
})

// ─── formatReviewComment tests ─────────────────────────────────────────────────

describe("formatReviewComment", () => {
  it("includes task ID in header", () => {
    const result = formatReviewComment("## Verdict: PASS\n\nAll good.", "review-pr-42-260413-102421")
    expect(result).toContain("review-pr-42-260413-102421")
  })

  it("includes verdict PASS in output", () => {
    const result = formatReviewComment("## Verdict: PASS\n\nNo issues.", "review-test")
    expect(result).toContain("## Verdict: PASS")
  })

  it("includes CTA when verdict is FAIL", () => {
    const content = "## Verdict: FAIL\n\n### Critical\nSomething is broken."
    const result = formatReviewComment(content, "review-test")
    expect(result).toContain("Verdict: FAIL")
    expect(result).toContain("@kody fix")
  })

  it("does not include CTA when verdict is PASS", () => {
    const content = "## Verdict: PASS\n\nAll good."
    const result = formatReviewComment(content, "review-test")
    expect(result).not.toContain("@kody fix")
  })

  it("includes Kody attribution footer", () => {
    const result = formatReviewComment("## Verdict: PASS\n\nOK.", "review-test")
    expect(result).toContain("🤖 Generated by Kody")
  })

  it("handles empty review content gracefully", () => {
    const result = formatReviewComment("", "review-test")
    expect(result).toContain("review-test")
    expect(result).toContain("🤖 Generated by Kody")
  })
})

// ─── detectReviewVerdict tests ─────────────────────────────────────────────────
//
// The regex /###\s*Critical\s*\n(?!None\.)/i requires a single \n (no blank
// line) after the "Critical" heading, then asserts "None." is NOT the next
// content.  Test strings use single-newline format to match this precisely.

describe("detectReviewVerdict", () => {
  it('returns "pass" for Verdict: PASS', () => {
    expect(detectReviewVerdict("## Verdict: PASS\n\nAll good.")).toBe("pass")
  })

  it('returns "fail" for Verdict: FAIL', () => {
    expect(detectReviewVerdict("## Verdict: FAIL\n\nSomething broken.")).toBe("fail")
  })

  // Note: if a "## Verdict: PASS/FAIL" line is present, it takes priority
  // and Critical/Major checks are never reached. The following tests cover
  // the fallback path (no verdict line → check Critical/Major sections).
  it('returns "fail" when Critical section has content (no verdict line)', () => {
    // No ## Verdict line → falls through to Critical check
    // \n after Critical → lookahead sees "S" (not "None.") → match → "fail"
    const content = "### Critical\nSomething critical broken."
    expect(detectReviewVerdict(content)).toBe("fail")
  })

  it('returns "fail" when Major section has content (no verdict line)', () => {
    const content = "### Major\nSomething important wrong."
    expect(detectReviewVerdict(content)).toBe("fail")
  })

  it('returns "pass" when only Minor findings exist', () => {
    const content = "## Verdict: PASS\n\n### Minor\nA minor style issue."
    expect(detectReviewVerdict(content)).toBe("pass")
  })

  it('returns "pass" when Critical section has None', () => {
    // Single \n after Critical → lookahead sees "None." → fails → no match → "pass"
    const content = "## Verdict: PASS\n\n### Critical\nNone."
    expect(detectReviewVerdict(content)).toBe("pass")
  })

  it('returns "pass" when Major section has None', () => {
    const content = "## Verdict: PASS\n\n### Major\nNone."
    expect(detectReviewVerdict(content)).toBe("pass")
  })

  it("is case-insensitive", () => {
    expect(detectReviewVerdict("## verdict: pass\n\nOK.")).toBe("pass")
    expect(detectReviewVerdict("## verdict: fail\n\nBroken.")).toBe("fail")
  })
})
