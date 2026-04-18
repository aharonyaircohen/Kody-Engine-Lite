import { describe, it, expect } from "vitest"
import { deriveBranchName, UncommittedChangesError } from "../../../src-v2/branch.js"

describe("branch: deriveBranchName", () => {
  it("slugifies title with issue number prefix", () => {
    expect(deriveBranchName(42, "Add feature X")).toBe("42-add-feature-x")
  })

  it("strips special characters", () => {
    expect(deriveBranchName(7, "Fix: bug! (urgent)")).toBe("7-fix-bug-urgent")
  })

  it("collapses repeated dashes", () => {
    expect(deriveBranchName(1, "a   b---c")).toBe("1-a-b-c")
  })

  it("trims trailing dash", () => {
    expect(deriveBranchName(1, "feature-")).toBe("1-feature")
  })

  it("caps slug length to 50 chars", () => {
    const long = "a".repeat(80)
    const result = deriveBranchName(1, long)
    expect(result.length).toBeLessThanOrEqual(53)
    expect(result.startsWith("1-")).toBe(true)
  })

  it("handles empty title", () => {
    expect(deriveBranchName(99, "")).toBe("99")
  })

  it("handles title that produces empty slug", () => {
    expect(deriveBranchName(99, "!!!")).toBe("99")
  })
})

describe("branch: UncommittedChangesError", () => {
  it("includes branch name in message", () => {
    const err = new UncommittedChangesError("feat-branch")
    expect(err.message).toMatch(/feat-branch/)
    expect(err.name).toBe("UncommittedChangesError")
    expect(err.branch).toBe("feat-branch")
  })
})
