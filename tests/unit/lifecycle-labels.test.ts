import { describe, it, expect, vi, beforeEach } from "vitest"
import type { StageDefinition, PipelineContext } from "../../src/types.js"

// Mock github-api before importing hooks
vi.mock("../../src/github-api.js", () => ({
  setLifecycleLabel: vi.fn(),
  setLabel: vi.fn(),
  removeLabel: vi.fn(),
  postComment: vi.fn(),
  setGhCwd: vi.fn(),
  getIssueLabels: vi.fn(() => []),
}))

vi.mock("../../src/git-utils.js", () => ({
  ensureFeatureBranch: vi.fn(() => "42-test-branch"),
  syncWithDefault: vi.fn(),
  getCurrentBranch: vi.fn(() => "42-test-branch"),
  getDefaultBranch: vi.fn(() => "dev"),
  commitAll: vi.fn(() => ({ success: false, hash: "", message: "No changes" })),
  pushBranch: vi.fn(),
}))

import { applyPreStageLabel } from "../../src/pipeline/hooks.js"
import { setLifecycleLabel } from "../../src/github-api.js"

function makeDef(name: string): StageDefinition {
  return { name, type: "agent", modelTier: "mid", timeout: 60_000, maxRetries: 1 } as StageDefinition
}

function makeCtx(issueNumber?: number, local = false): PipelineContext {
  return {
    taskId: "test-task",
    taskDir: "/tmp/test",
    projectDir: "/tmp",
    runners: {},
    input: { mode: "full", issueNumber, local },
  } as PipelineContext
}

describe("applyPreStageLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Existing stages that already had labels ──

  it("sets 'building' for build stage", () => {
    applyPreStageLabel(makeCtx(42), makeDef("build"))
    expect(setLifecycleLabel).toHaveBeenCalledWith(42, "building")
  })

  it("sets 'review' for review stage", () => {
    applyPreStageLabel(makeCtx(42), makeDef("review"))
    expect(setLifecycleLabel).toHaveBeenCalledWith(42, "review")
  })

  it("sets 'shipping' for ship stage", () => {
    applyPreStageLabel(makeCtx(42), makeDef("ship"))
    expect(setLifecycleLabel).toHaveBeenCalledWith(42, "shipping")
  })

  // ── NEW: stages that were missing labels ──

  it("sets 'planning' for plan stage", () => {
    applyPreStageLabel(makeCtx(42), makeDef("plan"))
    expect(setLifecycleLabel).toHaveBeenCalledWith(42, "planning")
  })

  it("sets 'verifying' for verify stage", () => {
    applyPreStageLabel(makeCtx(42), makeDef("verify"))
    expect(setLifecycleLabel).toHaveBeenCalledWith(42, "verifying")
  })

  it("sets 'fixing' for review-fix stage", () => {
    applyPreStageLabel(makeCtx(42), makeDef("review-fix"))
    expect(setLifecycleLabel).toHaveBeenCalledWith(42, "fixing")
  })

  // ── Guard: no-op cases ──

  it("does nothing without issueNumber", () => {
    applyPreStageLabel(makeCtx(undefined), makeDef("build"))
    expect(setLifecycleLabel).not.toHaveBeenCalled()
  })

  it("does nothing in local mode", () => {
    applyPreStageLabel(makeCtx(42, true), makeDef("build"))
    expect(setLifecycleLabel).not.toHaveBeenCalled()
  })

  it("does nothing for taskify (covered by pipeline start)", () => {
    applyPreStageLabel(makeCtx(42), makeDef("taskify"))
    expect(setLifecycleLabel).not.toHaveBeenCalled()
  })
})

describe("LIFECYCLE_LABELS includes new phases", () => {
  // LIFECYCLE_LABELS is not exported, but setLifecycleLabel silently
  // skips invalid phases. We test via the real (unmocked) module.
  // Since github-api is mocked above, we validate the source directly.
  it("verifying and fixing are listed in LIFECYCLE_LABELS constant", async () => {
    const fs = await import("fs")
    const source = fs.readFileSync("src/github-api.ts", "utf-8")
    const match = source.match(/LIFECYCLE_LABELS\s*=\s*\[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const labels = match![1]
    expect(labels).toContain('"verifying"')
    expect(labels).toContain('"fixing"')
  })
})
