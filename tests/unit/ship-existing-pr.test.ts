import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { executeShipStage, buildPrBody } from "../../src/stages/ship.js"
import * as githubApi from "../../src/github-api.js"
import * as gitUtils from "../../src/git-utils.js"
import * as config from "../../src/config.js"
import type { PipelineContext, StageDefinition } from "../../src/types.js"

vi.mock("../../src/git-utils.js", () => ({
  getCurrentBranch: vi.fn(() => "feat/fix-branch"),
  getDefaultBranch: vi.fn(() => "main"),
  pushBranch: vi.fn(),
}))

vi.mock("../../src/github-api.js", () => ({
  getPRForBranch: vi.fn(),
  updatePR: vi.fn(),
  createPR: vi.fn(),
  postComment: vi.fn(),
}))

vi.mock("../../src/config.js", () => ({
  getProjectConfig: vi.fn(() => ({
    github: { owner: "test-owner", repo: "test-repo" },
  })),
  resetProjectConfig: vi.fn(),
  setConfigDir: vi.fn(),
}))

const stubDef: StageDefinition = {
  name: "ship",
  type: "deterministic",
  modelTier: "cheap",
  timeout: 60_000,
  maxRetries: 0,
}

function makeTmpDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-ship-test-"))
  const taskDir = path.join(tmpDir, ".kody/tasks", "ship-test")
  fs.mkdirSync(taskDir, { recursive: true })
  // Minimal task.json
  fs.writeFileSync(
    path.join(taskDir, "task.json"),
    JSON.stringify({
      task_type: "feature",
      title: "Add validation",
      description: "Add weight validation",
      scope: ["src/collections/Courses.ts"],
      risk_level: "low",
    }),
  )
  return tmpDir
}

function makeCtx(tmpDir: string, overrides: Partial<PipelineContext["input"]> = {}): PipelineContext {
  return {
    taskId: "ship-test",
    taskDir: path.join(tmpDir, ".kody/tasks", "ship-test"),
    projectDir: tmpDir,
    runners: {},
    input: {
      mode: "full",
      ...overrides,
    },
  }
}

describe("ship stage: existing PR detection", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    vi.clearAllMocks()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates a new PR when no existing PR found", () => {
    vi.mocked(githubApi.getPRForBranch).mockReturnValue(null)
    vi.mocked(githubApi.createPR).mockReturnValue({
      number: 150,
      url: "https://github.com/test-owner/test-repo/pull/150",
    })

    const ctx = makeCtx(tmpDir)
    const result = executeShipStage(ctx, stubDef)

    expect(result.outcome).toBe("completed")
    expect(githubApi.getPRForBranch).toHaveBeenCalledWith("feat/fix-branch")
    expect(githubApi.createPR).toHaveBeenCalledOnce()
    expect(githubApi.updatePR).not.toHaveBeenCalled()

    const shipMd = fs.readFileSync(path.join(ctx.taskDir, "ship.md"), "utf-8")
    expect(shipMd).toContain("PR created")
    expect(shipMd).toContain("#150")
  })

  it("updates existing PR instead of creating a new one", () => {
    vi.mocked(githubApi.getPRForBranch).mockReturnValue({
      number: 148,
      url: "https://github.com/test-owner/test-repo/pull/148",
    })

    const ctx = makeCtx(tmpDir)
    const result = executeShipStage(ctx, stubDef)

    expect(result.outcome).toBe("completed")
    expect(githubApi.getPRForBranch).toHaveBeenCalledWith("feat/fix-branch")
    expect(githubApi.createPR).not.toHaveBeenCalled()
    expect(githubApi.updatePR).toHaveBeenCalledWith(148, expect.any(String))

    const shipMd = fs.readFileSync(path.join(ctx.taskDir, "ship.md"), "utf-8")
    expect(shipMd).toContain("Updated existing PR")
    expect(shipMd).toContain("#148")
  })

  it("posts fix comment on issue when updating existing PR", () => {
    vi.mocked(githubApi.getPRForBranch).mockReturnValue({
      number: 148,
      url: "https://github.com/test-owner/test-repo/pull/148",
    })

    const ctx = makeCtx(tmpDir, { issueNumber: 148 })
    executeShipStage(ctx, stubDef)

    expect(githubApi.postComment).toHaveBeenCalledWith(
      148,
      expect.stringContaining("Fix pushed to PR #148"),
    )
  })

  it("posts creation comment when creating new PR", () => {
    vi.mocked(githubApi.getPRForBranch).mockReturnValue(null)
    vi.mocked(githubApi.createPR).mockReturnValue({
      number: 150,
      url: "https://github.com/test-owner/test-repo/pull/150",
    })

    const ctx = makeCtx(tmpDir, { issueNumber: 102 })
    executeShipStage(ctx, stubDef)

    expect(githubApi.postComment).toHaveBeenCalledWith(
      102,
      expect.stringContaining("PR created"),
    )
  })

  it("always pushes the branch regardless of existing PR", () => {
    vi.mocked(githubApi.getPRForBranch).mockReturnValue({
      number: 148,
      url: "https://github.com/test-owner/test-repo/pull/148",
    })

    const ctx = makeCtx(tmpDir)
    executeShipStage(ctx, stubDef)

    expect(gitUtils.pushBranch).toHaveBeenCalledWith(tmpDir)
  })

  it("skips PR operations in dry run mode", () => {
    const ctx = makeCtx(tmpDir, { dryRun: true })
    const result = executeShipStage(ctx, stubDef)

    expect(result.outcome).toBe("completed")
    expect(githubApi.getPRForBranch).not.toHaveBeenCalled()
    expect(githubApi.createPR).not.toHaveBeenCalled()
    expect(githubApi.updatePR).not.toHaveBeenCalled()
  })

  it("skips in local mode with no issue number", () => {
    const ctx = makeCtx(tmpDir, { local: true })
    const result = executeShipStage(ctx, stubDef)

    expect(result.outcome).toBe("completed")
    expect(githubApi.getPRForBranch).not.toHaveBeenCalled()
  })

  it("does not post comment when in local mode with existing PR", () => {
    vi.mocked(githubApi.getPRForBranch).mockReturnValue({
      number: 148,
      url: "https://github.com/test-owner/test-repo/pull/148",
    })

    const ctx = makeCtx(tmpDir, { local: true, issueNumber: 148 })
    executeShipStage(ctx, stubDef)

    expect(githubApi.postComment).not.toHaveBeenCalled()
  })
})
