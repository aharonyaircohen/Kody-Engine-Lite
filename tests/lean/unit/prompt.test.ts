import { describe, it, expect } from "vitest"
import { buildPrompt, parseAgentResult } from "../../../src-v2/prompt.js"
import type { KodyLeanConfig } from "../../../src-v2/config.js"

const baseConfig: KodyLeanConfig = {
  quality: { typecheck: "pnpm tc", testUnit: "pnpm test", lint: "" },
  git: { defaultBranch: "main" },
  github: { owner: "o", repo: "r" },
  agent: { model: "minimax/m" },
}

describe("prompt: buildPrompt", () => {
  it("includes issue body, branch, and quality commands", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 42, title: "Add X", body: "BODY HERE", comments: [] },
      featureBranch: "42-add-x",
    })
    expect(p).toMatch(/Add X/)
    expect(p).toMatch(/BODY HERE/)
    expect(p).toMatch(/42-add-x/)
    expect(p).toMatch(/pnpm tc/)
    expect(p).toMatch(/pnpm test/)
  })

  it("omits empty quality commands", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
    })
    expect(p).not.toMatch(/^- lint:/m)
  })

  it("includes lint when configured", () => {
    const cfg = { ...baseConfig, quality: { ...baseConfig.quality, lint: "pnpm lint" } }
    const p = buildPrompt({
      config: cfg,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/pnpm lint/)
  })

  it("includes recent comments most-recent-first, capped at 5", () => {
    const comments = Array.from({ length: 8 }, (_, i) => ({
      body: `comment ${i}`,
      author: `user${i}`,
      createdAt: `2026-04-0${i + 1}`,
    }))
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/comment 7/)
    expect(p).toMatch(/comment 3/)
    expect(p).not.toMatch(/comment 0/)
    const lastIdx = p.indexOf("comment 7")
    const firstIdx = p.indexOf("comment 3")
    expect(lastIdx).toBeLessThan(firstIdx)
  })

  it("truncates comments larger than 4KB", () => {
    const huge = "x".repeat(5000)
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [{ body: huge, author: "u", createdAt: "" }] },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/truncated/)
  })

  it("instructs not to run git/gh", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/Do NOT run \*\*any\*\* `git` or `gh` commands/)
  })
})

describe("prompt: parseAgentResult", () => {
  it("parses DONE + COMMIT_MSG + PR_SUMMARY", () => {
    const result = parseAgentResult(
      "DONE\nCOMMIT_MSG: feat: add X\nPR_SUMMARY:\n- Added X\n- Updated Y",
    )
    expect(result.done).toBe(true)
    expect(result.commitMessage).toBe("feat: add X")
    expect(result.prSummary).toBe("- Added X\n- Updated Y")
  })

  it("parses FAILED with reason", () => {
    const result = parseAgentResult("FAILED: tests broken")
    expect(result.done).toBe(false)
    expect(result.failureReason).toBe("tests broken")
  })

  it("returns failure when no marker present", () => {
    const result = parseAgentResult("just some text")
    expect(result.done).toBe(false)
    expect(result.failureReason).toMatch(/no DONE or FAILED/)
  })

  it("returns failure when text is empty", () => {
    const result = parseAgentResult("")
    expect(result.done).toBe(false)
    expect(result.failureReason).toMatch(/no final message/)
  })

  it("DONE without COMMIT_MSG returns empty commit msg", () => {
    const result = parseAgentResult("DONE")
    expect(result.done).toBe(true)
    expect(result.commitMessage).toBe("")
  })

  it("DONE without PR_SUMMARY returns empty summary", () => {
    const result = parseAgentResult("DONE\nCOMMIT_MSG: feat: x")
    expect(result.done).toBe(true)
    expect(result.prSummary).toBe("")
  })

  it("ignores surrounding text around DONE marker", () => {
    const result = parseAgentResult("All set!\n\nDONE\nCOMMIT_MSG: chore: tidy\nPR_SUMMARY:\nMinor cleanup.")
    expect(result.done).toBe(true)
    expect(result.commitMessage).toBe("chore: tidy")
    expect(result.prSummary).toBe("Minor cleanup.")
  })

  it("strips trailing code-fence markers from PR_SUMMARY", () => {
    const result = parseAgentResult("DONE\nCOMMIT_MSG: feat: x\nPR_SUMMARY:\n- Added foo\n```")
    expect(result.prSummary).toBe("- Added foo")
  })
})
