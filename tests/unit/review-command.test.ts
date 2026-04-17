import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

describe("review command CLI parsing", () => {
  it("parseArgs recognizes 'review' as a valid command", async () => {
    // Simulate: kody review --pr-number 42
    const original = process.argv
    process.argv = ["node", "kody", "review", "--pr-number", "42"]
    const { parseArgs } = await import("../../src/cli/args.js")
    const input = parseArgs()
    expect(input.command).toBe("review")
    expect(input.prNumber).toBe(42)
    process.argv = original
  })

  it("parseArgs reads --pr-number flag", async () => {
    const original = process.argv
    process.argv = ["node", "kody", "review", "--pr-number", "101"]
    const { parseArgs } = await import("../../src/cli/args.js")
    const input = parseArgs()
    expect(input.prNumber).toBe(101)
    process.argv = original
  })

  it("parseArgs reads PR_NUMBER from env", async () => {
    const original = process.argv
    const originalEnv = process.env.PR_NUMBER
    process.argv = ["node", "kody", "review"]
    process.env.PR_NUMBER = "55"
    const { parseArgs } = await import("../../src/cli/args.js")
    const input = parseArgs()
    expect(input.prNumber).toBe(55)
    process.argv = original
    if (originalEnv === undefined) delete process.env.PR_NUMBER
    else process.env.PR_NUMBER = originalEnv
  })

  it("review command works with --issue-number to find PRs", async () => {
    const original = process.argv
    process.argv = ["node", "kody", "review", "--issue-number", "42"]
    const { parseArgs } = await import("../../src/cli/args.js")
    const input = parseArgs()
    expect(input.command).toBe("review")
    expect(input.issueNumber).toBe(42)
    process.argv = original
  })
})

// ─── GitHub API: PR lookup ──────────────────────────────────────────────────

describe("github-api PR helpers", () => {
  it("getPRsForIssue is exported", async () => {
    const api = await import("../../src/github-api.js")
    expect(typeof api.getPRsForIssue).toBe("function")
  })

  it("postPRComment is exported", async () => {
    const api = await import("../../src/github-api.js")
    expect(typeof api.postPRComment).toBe("function")
  })

  it("getPRDetails is exported", async () => {
    const api = await import("../../src/github-api.js")
    expect(typeof api.getPRDetails).toBe("function")
  })
})

// ─── Standalone Review Execution ────────────────────────────────────────────

describe("runStandaloneReview", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-review-test-"))
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

  function createMockRunner(reviewOutput?: string): AgentRunner {
    return {
      async run(stageName: string): Promise<AgentResult> {
        if (stageName === "review") {
          return {
            outcome: "completed",
            output: reviewOutput ?? "## Verdict: PASS\n\n## Summary\nAll good.\n\n## Findings\n\n### Critical\nNone.\n\n### Major\nNone.\n\n### Minor\nNone.",
          }
        }
        return { outcome: "completed", output: "Done" }
      },
      async healthCheck() { return true },
    }
  }

  it("runStandaloneReview returns review content", async () => {
    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: add search",
      prBody: "Adds search functionality",
      local: true,
    })

    expect(result.outcome).toBe("completed")
    expect(result.reviewContent).toContain("Verdict: PASS")
  })

  it("runStandaloneReview creates task dir with task.md from PR info", async () => {
    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "fix: broken auth",
      prBody: "Fixes the auth token refresh bug",
      local: true,
    })

    expect(result.outcome).toBe("completed")
    // Task dir should have been created with task.md
    expect(result.taskDir).toBeTruthy()
    const taskMd = fs.readFileSync(path.join(result.taskDir!, "task.md"), "utf-8")
    expect(taskMd).toContain("fix: broken auth")
    expect(taskMd).toContain("Fixes the auth token refresh bug")
  })

  it("runStandaloneReview produces review.md in task dir", async () => {
    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "test PR",
      prBody: "test body",
      local: true,
    })

    const reviewPath = path.join(result.taskDir!, "review.md")
    expect(fs.existsSync(reviewPath)).toBe(true)
  })

  it("runStandaloneReview returns failed outcome on agent failure", async () => {
    const failRunner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return { outcome: "failed", error: "Agent crashed" }
      },
      async healthCheck() { return true },
    }

    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: failRunner },
      prTitle: "test",
      prBody: "test",
      local: true,
    })

    expect(result.outcome).toBe("failed")
    expect(result.error).toContain("Agent crashed")
  })

  it("runStandaloneReview handles FAIL verdict", async () => {
    const failReview = "## Verdict: FAIL\n\n## Summary\nSecurity issue.\n\n## Findings\n\n### Critical\nSQL injection in query builder.\n\n### Major\nNone.\n\n### Minor\nNone."
    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner(failReview) },
      prTitle: "test",
      prBody: "test",
      local: true,
    })

    expect(result.outcome).toBe("completed")
    expect(result.reviewContent).toContain("Verdict: FAIL")
    expect(result.reviewContent).toContain("SQL injection")
  })
})

// ─── Multi-PR edge case ─────────────────────────────────────────────────────

describe("multi-PR resolution", () => {
  it("resolveReviewTarget returns error when issue has multiple PRs", async () => {
    const { resolveReviewTarget } = await import("../../src/review-standalone.js")

    const result = resolveReviewTarget({
      issueNumber: 42,
      prs: [
        { number: 101, title: "feat: add auth", url: "https://github.com/org/repo/pull/101", headBranch: "101-auth" },
        { number: 105, title: "fix: auth refresh", url: "https://github.com/org/repo/pull/105", headBranch: "105-fix" },
      ],
    })

    expect(result.action).toBe("pick")
    expect(result.prs).toHaveLength(2)
    expect(result.message).toContain("#42")
    expect(result.message).toContain("#101")
    expect(result.message).toContain("#105")
  })

  it("resolveReviewTarget returns the single PR when only one exists", async () => {
    const { resolveReviewTarget } = await import("../../src/review-standalone.js")

    const result = resolveReviewTarget({
      issueNumber: 42,
      prs: [
        { number: 101, title: "feat: add auth", url: "https://github.com/org/repo/pull/101", headBranch: "101-auth" },
      ],
    })

    expect(result.action).toBe("review")
    expect(result.prNumber).toBe(101)
  })

  it("resolveReviewTarget returns error when issue has no PRs", async () => {
    const { resolveReviewTarget } = await import("../../src/review-standalone.js")

    const result = resolveReviewTarget({
      issueNumber: 42,
      prs: [],
    })

    expect(result.action).toBe("none")
    expect(result.message).toContain("no open PRs")
  })
})

// ─── Review output formatting ───────────────────────────────────────────────

describe("formatReviewComment", () => {
  it("wraps review content for PR comment", async () => {
    const { formatReviewComment } = await import("../../src/review-standalone.js")

    const output = formatReviewComment(
      "## Verdict: PASS\n\n## Summary\nAll good.",
      "review-42",
    )

    expect(output).toContain("Verdict: PASS")
    expect(output).toContain("Kody")
    expect(output).toContain("review-42")
  })

  it("adds @kody fix CTA when verdict is FAIL", async () => {
    const { formatReviewComment } = await import("../../src/review-standalone.js")

    const output = formatReviewComment(
      "## Verdict: FAIL\n\n## Summary\nSecurity issue.\n\n## Findings\n\n### Critical\nSQL injection.\n\n### Major\nNone.\n\n### Minor\nNone.",
      "review-42",
    )

    expect(output).toContain("@kody fix")
    expect(output).toContain("review findings will be used automatically")
  })

  it("does not add @kody fix CTA when verdict is PASS", async () => {
    const { formatReviewComment } = await import("../../src/review-standalone.js")

    const output = formatReviewComment(
      "## Verdict: PASS\n\n## Summary\nAll good.\n\n## Findings\n\n### Critical\nNone.\n\n### Major\nNone.\n\n### Minor\nNone.",
      "review-42",
    )

    expect(output).not.toContain("@kody fix")
  })
})

// ─── Verdict detection ─────────────────────────────────────────────────────

describe("detectReviewVerdict", () => {
  it("detects PASS verdict", async () => {
    const { detectReviewVerdict } = await import("../../src/review-standalone.js")
    expect(detectReviewVerdict("## Verdict: PASS\n\nAll good.")).toBe("pass")
  })

  it("detects FAIL verdict", async () => {
    const { detectReviewVerdict } = await import("../../src/review-standalone.js")
    expect(detectReviewVerdict("## Verdict: FAIL\n\nSecurity issue.")).toBe("fail")
  })

  it("detects FAIL verdict case-insensitively", async () => {
    const { detectReviewVerdict } = await import("../../src/review-standalone.js")
    expect(detectReviewVerdict("## Verdict: fail\n\nBad code.")).toBe("fail")
  })

  it("falls back to fail when critical findings exist without explicit verdict", async () => {
    const { detectReviewVerdict } = await import("../../src/review-standalone.js")
    const content = "## Summary\nBad.\n\n## Findings\n\n### Critical\nSQL injection in query.\n\n### Major\nNone.\n\n### Minor\nNone."
    expect(detectReviewVerdict(content)).toBe("fail")
  })

  it("falls back to fail when major findings exist without explicit verdict", async () => {
    const { detectReviewVerdict } = await import("../../src/review-standalone.js")
    const content = "## Summary\nIssues.\n\n## Findings\n\n### Critical\nNone.\n\n### Major\nMissing error handling.\n\n### Minor\nNone."
    expect(detectReviewVerdict(content)).toBe("fail")
  })

  it("falls back to pass when no critical/major findings and no explicit verdict", async () => {
    const { detectReviewVerdict } = await import("../../src/review-standalone.js")
    const content = "## Summary\nLooks fine.\n\n## Findings\n\n### Critical\nNone.\n\n### Major\nNone.\n\n### Minor\nSmall style issue."
    expect(detectReviewVerdict(content)).toBe("pass")
  })
})

// ─── GitHub API: new review functions ──────────────────────────────────────

describe("github-api review functions", () => {
  it("submitPRReview is exported", async () => {
    const api = await import("../../src/github-api.js")
    expect(typeof api.submitPRReview).toBe("function")
  })

  it("getLatestKodyReviewComment is exported", async () => {
    const api = await import("../../src/github-api.js")
    expect(typeof api.getLatestKodyReviewComment).toBe("function")
  })
})
