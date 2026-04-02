import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

vi.mock("../../src/git-utils.js", () => ({
  getDefaultBranch: vi.fn(() => "dev"),
  getCurrentBranch: vi.fn(() => "42-add-feature"),
  mergeDefault: vi.fn(() => "clean"),
  getConflictedFiles: vi.fn(() => ["src/foo.ts"]),
  syncWithDefault: vi.fn(),
  commitAll: vi.fn(() => ({ success: true, hash: "abc1234", message: "resolve" })),
  pushBranch: vi.fn(),
}))

vi.mock("../../src/github-api.js", () => ({
  postPRComment: vi.fn(),
  getPRDetails: vi.fn(() => ({
    title: "Add feature",
    body: "Feature description",
    headBranch: "42-add-feature",
  })),
  setLifecycleLabel: vi.fn(),
  setLabel: vi.fn(),
  removeLabel: vi.fn(),
  postComment: vi.fn(),
  setGhCwd: vi.fn(),
  getIssueLabels: vi.fn(() => []),
}))

vi.mock("../../src/verify-runner.js", () => ({
  runQualityGates: vi.fn(() => ({
    pass: true,
    errors: [],
    summary: ["All checks passed"],
    rawOutputs: [],
  })),
  parseCommand: vi.fn((cmd: string) => cmd.split(" ")),
}))

import * as gitUtils from "../../src/git-utils.js"
import * as githubApi from "../../src/github-api.js"
import * as verifyRunner from "../../src/verify-runner.js"
import { runResolve } from "../../src/resolve.js"
import type { AgentRunner, AgentResult } from "../../src/types.js"

function createMockRunner(): AgentRunner {
  return {
    async run(): Promise<AgentResult> {
      return { outcome: "completed", output: "Conflicts resolved" }
    },
    async healthCheck() { return true },
  }
}

function setup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-resolve-"))
  fs.writeFileSync(
    path.join(tmpDir, "kody.config.json"),
    JSON.stringify({
      quality: { typecheck: "true", lint: "", lintFix: "", formatFix: "", testUnit: "true" },
      agent: { defaultRunner: "claude" },
    }),
  )
  setConfigDir(tmpDir)
  return {
    tmpDir,
    cleanup: () => {
      resetProjectConfig()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

describe("runResolve", () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset default return values (clearAllMocks only clears call history)
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("clean")
    vi.mocked(gitUtils.getConflictedFiles).mockReturnValue(["src/foo.ts"])
    vi.mocked(gitUtils.commitAll).mockReturnValue({ success: true, hash: "abc1234", message: "resolve" })
    vi.mocked(verifyRunner.runQualityGates).mockReturnValue({
      pass: true, errors: [], summary: ["All checks passed"], rawOutputs: [],
    })
    const s = setup()
    tmpDir = s.tmpDir
    cleanup = s.cleanup
  })
  afterEach(() => cleanup())

  it("returns merged when merge is clean", async () => {
    const result = await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(result.outcome).toBe("merged")
    expect(gitUtils.mergeDefault).toHaveBeenCalledWith(tmpDir)
    expect(gitUtils.commitAll).not.toHaveBeenCalled()
  })

  it("runs agent to resolve conflicts when merge has conflicts", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")

    const runner = createMockRunner()
    const runSpy = vi.spyOn(runner, "run")

    const result = await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: runner },
      local: false,
    })

    expect(result.outcome).toBe("resolved")
    expect(runSpy).toHaveBeenCalledWith(
      "resolve",
      expect.stringContaining("conflict"),
      expect.any(String),
      expect.any(Number),
      expect.any(String),
      expect.any(Object),
    )
    expect(gitUtils.commitAll).toHaveBeenCalledWith(
      expect.stringContaining("resolve merge conflicts"),
      tmpDir,
    )
  })

  it("runs verify after conflict resolution scoped to conflicted files", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")
    vi.mocked(gitUtils.getConflictedFiles).mockReturnValue(["src/auth/auth.ts"])

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(verifyRunner.runQualityGates).toHaveBeenCalledWith(
      tmpDir,
      tmpDir,
      { onlyFailOnFiles: ["src/auth/auth.ts"] },
    )
  })

  it("fails when verify fails after resolution", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")
    vi.mocked(verifyRunner.runQualityGates).mockReturnValue({
      pass: false,
      errors: ["Type error in src/foo.ts"],
      summary: [],
      rawOutputs: [],
    })

    const result = await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(result.outcome).toBe("failed")
    expect(result.error).toContain("verification")
  })

  it("succeeds when verify passes (pre-existing errors suppressed by onlyFailOnFiles)", async () => {
    // runQualityGates returns pass=true because onlyFailOnFiles filtered out
    // the pre-existing errors — resolve should succeed
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")
    vi.mocked(verifyRunner.runQualityGates).mockReturnValue({
      pass: true,
      errors: [],
      summary: ["pre-existing errors suppressed"],
      rawOutputs: [],
    })

    const result = await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(result.outcome).toBe("resolved")
  })

  it("pushes after successful resolution (non-local)", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(gitUtils.pushBranch).toHaveBeenCalledWith(tmpDir)
  })

  it("does NOT push in local mode", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: true,
    })

    expect(gitUtils.pushBranch).not.toHaveBeenCalled()
  })

  it("posts diff comment on PR after resolution (non-local)", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(githubApi.postPRComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("resolve"),
    )
  })

  it("pushes clean merge (non-local)", async () => {
    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(gitUtils.pushBranch).toHaveBeenCalledWith(tmpDir)
  })

  it("does NOT push clean merge in local mode", async () => {
    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: true,
    })

    expect(gitUtils.pushBranch).not.toHaveBeenCalled()
  })

  // --- PR comment coverage ---

  it("posts clean-merge comment on PR (non-local)", async () => {
    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(githubApi.postPRComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Clean merge"),
    )
  })

  it("does NOT post clean-merge comment in local mode", async () => {
    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: true,
    })

    expect(githubApi.postPRComment).not.toHaveBeenCalled()
  })

  it("posts failure comment when merge errors (non-local)", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("error")

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(githubApi.postPRComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Resolve failed"),
    )
  })

  it("does NOT post failure comment in local mode", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("error")

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: true,
    })

    expect(githubApi.postPRComment).not.toHaveBeenCalled()
  })

  it("posts failure comment when no conflicted files found (non-local)", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")
    vi.mocked(gitUtils.getConflictedFiles).mockReturnValue([])

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(githubApi.postPRComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Resolve failed"),
    )
  })

  it("posts failure comment when agent fails (non-local)", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")
    const failRunner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return { outcome: "error", error: "Agent crashed", output: "" }
      },
      async healthCheck() { return true },
    }

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: failRunner },
      local: false,
    })

    expect(githubApi.postPRComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Resolve failed"),
    )
  })

  it("posts failure comment when verification fails (non-local)", async () => {
    vi.mocked(gitUtils.mergeDefault).mockReturnValue("conflict")
    vi.mocked(verifyRunner.runQualityGates).mockReturnValue({
      pass: false,
      errors: ["Type error in src/foo.ts"],
      summary: [],
      rawOutputs: [],
    })

    await runResolve({
      prNumber: 42,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      local: false,
    })

    expect(githubApi.postPRComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Resolve failed"),
    )
  })
})
