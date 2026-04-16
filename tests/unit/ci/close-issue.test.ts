import { describe, it, expect } from "vitest"

describe("extractIssueNumber (via close-issue logic)", () => {
  // Testing the extraction logic inline since the function is private.
  // This mirrors the regex from close-issue.ts.
  function extractIssueNumber(branchName: string): string | null {
    const match = branchName.match(/^(\d+)-/)
    return match ? match[1] : null
  }

  it("extracts number from branch like '42-feature-name'", () => {
    expect(extractIssueNumber("42-feature-name")).toBe("42")
  })

  it("extracts number from branch like '123-my-cool-feature'", () => {
    expect(extractIssueNumber("123-my-cool-feature")).toBe("123")
  })

  it("returns null for branch without leading number", () => {
    expect(extractIssueNumber("feature-branch")).toBeNull()
  })

  it("returns null for branch starting with dash", () => {
    expect(extractIssueNumber("-42-feature")).toBeNull()
  })

  it("returns null for branch with only number (no trailing dash)", () => {
    expect(extractIssueNumber("99")).toBeNull()
  })
})
