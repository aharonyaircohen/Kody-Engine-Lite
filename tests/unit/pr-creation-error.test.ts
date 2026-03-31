import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock child_process before importing modules that use it
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}))

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { execFileSync } from "child_process"
import { createPR } from "../../src/github-api.js"
import { logger } from "../../src/logger.js"

const mockExecFileSync = vi.mocked(execFileSync)

beforeEach(() => {
  vi.clearAllMocks()
})

describe("createPR error logging", () => {
  it("logs stderr when gh pr create fails with a GraphQL error", () => {
    const error = new Error("Command failed: gh pr create ...") as any
    error.stderr = Buffer.from(
      "pull request create failed: GraphQL: Base ref must be a branch (createPullRequest)"
    )
    mockExecFileSync.mockImplementation(() => { throw error })

    const result = createPR("feat/branch", "nonexistent", "title", "body")

    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Base ref must be a branch")
    )
    // Should NOT contain the raw "Command failed" noise
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Command failed")
    )
  })

  it("logs stderr string when stderr is a string (not Buffer)", () => {
    const error = new Error("Command failed") as any
    error.stderr = "No commits between main and main"
    mockExecFileSync.mockImplementation(() => { throw error })

    const result = createPR("main", "main", "title", "body")

    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("No commits between main and main")
    )
  })

  it("falls back to error.message when stderr is empty", () => {
    const error = new Error("spawn gh ENOENT") as any
    error.stderr = ""
    mockExecFileSync.mockImplementation(() => { throw error })

    const result = createPR("head", "base", "title", "body")

    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("spawn gh ENOENT")
    )
  })

  it("falls back to error.message when stderr is missing", () => {
    const error = new Error("unexpected failure")
    mockExecFileSync.mockImplementation(() => { throw error })

    const result = createPR("head", "base", "title", "body")

    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("unexpected failure")
    )
  })
})
