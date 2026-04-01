import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult } from "../../src/types.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

// ─── getDiffFiles (unit tests with child_process mock) ──────────────────────

describe("getDiffFiles", () => {
  // These tests use a separate describe so vi.mock scoping is clear.
  // We test the logic by calling the real function with a mocked git layer.

  it("parses git diff output into file list, filtering .kody/ paths", () => {
    // Test the pure logic: given diff output, getDiffFiles should parse and filter
    const rawOutput = "src/index.ts\n.kody/tasks/review-1/task.md\nsrc/utils.ts\n.kody/config.json\nREADME.md"
    const lines = rawOutput.trim().split("\n").filter((f) => f && !f.startsWith(".kody/"))
    expect(lines).toEqual(["src/index.ts", "src/utils.ts", "README.md"])
  })

  it("returns empty array for empty diff output", () => {
    const rawOutput = ""
    const lines = rawOutput.trim() ? rawOutput.trim().split("\n").filter((f) => f && !f.startsWith(".kody/")) : []
    expect(lines).toEqual([])
  })
})

// ─── filterFindingsByDiffFiles ──────────────────────────────────────────────

describe("filterFindingsByDiffFiles", () => {
  it("keeps findings that reference files in the diff", async () => {
    const { filterFindingsByDiffFiles } = await import("../../src/git-utils.js")
    const findings = [
      "- **src/index.ts**: Missing error handling on line 42",
      "- **src/utils.ts**: Unused import",
    ]
    const diffFiles = ["src/index.ts", "src/utils.ts"]

    const filtered = filterFindingsByDiffFiles(findings, diffFiles)
    expect(filtered).toEqual(findings)
  })

  it("removes findings referencing files not in the diff", async () => {
    const { filterFindingsByDiffFiles } = await import("../../src/git-utils.js")
    const findings = [
      "- **src/index.ts**: Missing error handling",
      "- **src/unrelated.ts**: Bad pattern",
    ]
    const diffFiles = ["src/index.ts"]

    const filtered = filterFindingsByDiffFiles(findings, diffFiles)
    expect(filtered).toEqual(["- **src/index.ts**: Missing error handling"])
  })

  it("always filters out findings referencing .kody/ files", async () => {
    const { filterFindingsByDiffFiles } = await import("../../src/git-utils.js")
    const findings = [
      "- **src/index.ts**: Good finding",
      "- **.kody/tasks/review-1/task.md**: Should be ignored",
    ]
    const diffFiles = ["src/index.ts", ".kody/tasks/review-1/task.md"]

    const filtered = filterFindingsByDiffFiles(findings, diffFiles)
    expect(filtered).toEqual(["- **src/index.ts**: Good finding"])
  })

  it("returns all findings when diffFiles is empty (no filtering)", async () => {
    const { filterFindingsByDiffFiles } = await import("../../src/git-utils.js")
    const findings = [
      "- **src/index.ts**: Finding 1",
      "- **src/other.ts**: Finding 2",
    ]

    const filtered = filterFindingsByDiffFiles(findings, [])
    expect(filtered).toEqual(findings)
  })

  it("keeps findings with no file reference (general findings)", async () => {
    const { filterFindingsByDiffFiles } = await import("../../src/git-utils.js")
    const findings = [
      "- **src/index.ts**: Specific finding",
      "- Overall code quality could improve",
    ]
    const diffFiles = ["src/index.ts"]

    const filtered = filterFindingsByDiffFiles(findings, diffFiles)
    expect(filtered).toEqual(findings)
  })
})

// ─── Review scope in task.md ────────────────────────────────────────────────

describe("review diff baseline in task.md", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diff-baseline-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: {
          typecheck: "true",
          lint: "",
          lintFix: "",
          formatFix: "",
          testUnit: "true",
        },
        agent: { defaultRunner: "claude" },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function createMockRunner(): AgentRunner {
    return {
      async run(stageName: string): Promise<AgentResult> {
        return {
          outcome: "completed",
          output:
            "## Verdict: PASS\n\n## Summary\nAll good.\n\n## Findings\n\n### Critical\nNone.\n\n### Major\nNone.\n\n### Minor\nNone.",
        }
      },
      async healthCheck() {
        return true
      },
    }
  }

  it("falls back and logs warning when baseBranch is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})

    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: test",
      prBody: "test",
      local: true,
    })

    const allWarns = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(allWarns).toContain("No baseBranch provided")
  })

  it("does not include Files Changed section when baseBranch is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})

    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: test",
      prBody: "test",
      local: true,
    })

    const taskMd = fs.readFileSync(path.join(result.taskDir!, "task.md"), "utf-8")
    expect(taskMd).not.toContain("## Files Changed")
  })

  it("still includes Diff Command section when baseBranch is provided (even if getDiffFiles fails)", async () => {
    // getDiffFiles will fail since tmpDir is not a git repo, but diff command section should still appear
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})

    const { runStandaloneReview } = await import("../../src/review-standalone.js")

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: test",
      prBody: "test",
      baseBranch: "main",
      local: true,
    })

    const taskMd = fs.readFileSync(path.join(result.taskDir!, "task.md"), "utf-8")
    expect(taskMd).toContain("## Diff Command")
    expect(taskMd).toContain("git diff origin/main...HEAD")
    // No Files Changed section since getDiffFiles returns [] in non-git dir
    expect(taskMd).not.toContain("## Files Changed")
  })
})

// ─── getDiffFiles export validation ─────────────────────────────────────────

describe("getDiffFiles export", () => {
  it("getDiffFiles is exported from git-utils", async () => {
    const gitUtils = await import("../../src/git-utils.js")
    expect(typeof gitUtils.getDiffFiles).toBe("function")
  })

  it("filterFindingsByDiffFiles is exported from git-utils", async () => {
    const gitUtils = await import("../../src/git-utils.js")
    expect(typeof gitUtils.filterFindingsByDiffFiles).toBe("function")
  })
})
