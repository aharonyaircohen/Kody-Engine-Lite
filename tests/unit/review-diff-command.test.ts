import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { AgentRunner, AgentResult } from "../../src/types.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("review standalone diff command injection", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diff-cmd-test-"))
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
        agent: { defaultRunner: "claude", modelMap: { cheap: "claude/test-model-cheap", mid: "claude/test-model-mid", strong: "claude/test-model-strong" } },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("includes diff command section in task.md when baseBranch is provided", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: add search",
      prBody: "Adds search functionality",
      baseBranch: "main",
      local: true,
    })

    expect(result.outcome).toBe("completed")
    expect(result.taskDir).toBeTruthy()

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    expect(taskMd).toContain("## Diff Command")
    expect(taskMd).toContain("git diff origin/main...HEAD")
  })

  it("uses the exact base branch name in the diff command", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "fix: auth bug",
      prBody: "Fixes refresh token",
      baseBranch: "develop",
      local: true,
    })

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    expect(taskMd).toContain("git diff origin/develop...HEAD")
    expect(taskMd).not.toContain("git diff origin/main")
  })

  it("does NOT include diff command section when baseBranch is omitted", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: add search",
      prBody: "Adds search functionality",
      local: true,
    })

    expect(result.outcome).toBe("completed")
    expect(result.taskDir).toBeTruthy()

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    expect(taskMd).not.toContain("## Diff Command")
    expect(taskMd).not.toContain("git diff origin/")
  })

  it("does NOT include diff command section when baseBranch is undefined", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "chore: cleanup",
      prBody: "Remove dead code",
      baseBranch: undefined,
      local: true,
    })

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    expect(taskMd).not.toContain("## Diff Command")
  })

  it("warns against bare git diff in the diff command section", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: new feature",
      prBody: "Description",
      baseBranch: "main",
      local: true,
    })

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    expect(taskMd).toContain("Do NOT use bare `git diff`")
    expect(taskMd).toContain("working tree changes")
  })

  it("preserves PR title and body alongside the diff command section", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: important feature",
      prBody: "This is a detailed description of the feature.",
      baseBranch: "main",
      local: true,
    })

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    // PR title appears as heading
    expect(taskMd).toContain("# feat: important feature")
    // PR body is present
    expect(taskMd).toContain(
      "This is a detailed description of the feature.",
    )
    // Diff command section is also present
    expect(taskMd).toContain("## Diff Command")
    expect(taskMd).toContain("git diff origin/main...HEAD")
  })

  it("preserves PR title and body when no baseBranch is provided", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "fix: minor fix",
      prBody: "Small patch for edge case.",
      local: true,
    })

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    expect(taskMd).toContain("# fix: minor fix")
    expect(taskMd).toContain("Small patch for edge case.")
    // No diff section injected
    expect(taskMd).not.toContain("## Diff Command")
  })

  it("handles branch names with slashes (e.g. release/v2.0)", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: release prep",
      prBody: "Preparing release",
      baseBranch: "release/v2.0",
      local: true,
    })

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    expect(taskMd).toContain("git diff origin/release/v2.0...HEAD")
  })

  it("diff command section appears after the PR body, not before it", async () => {
    const { runStandaloneReview } = await import(
      "../../src/review-standalone.js"
    )

    const result = await runStandaloneReview({
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      prTitle: "feat: ordering test",
      prBody: "Body comes first",
      baseBranch: "main",
      local: true,
    })

    const taskMd = fs.readFileSync(
      path.join(result.taskDir!, "task.md"),
      "utf-8",
    )
    const bodyIndex = taskMd.indexOf("Body comes first")
    const diffIndex = taskMd.indexOf("## Diff Command")
    expect(bodyIndex).toBeGreaterThan(-1)
    expect(diffIndex).toBeGreaterThan(-1)
    expect(diffIndex).toBeGreaterThan(bodyIndex)
  })
})
