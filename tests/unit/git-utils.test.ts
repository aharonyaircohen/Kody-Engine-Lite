import { describe, it, expect } from "vitest"
import { deriveBranchName } from "../../src/git-utils.js"

describe("deriveBranchName", () => {
  it("generates branch from issue number and title", () => {
    expect(deriveBranchName(42, "Add search feature")).toBe("42-add-search-feature")
  })

  it("lowercases and removes special chars", () => {
    expect(deriveBranchName(1, "Fix: Bug in Auth!")).toBe("1-fix-bug-in-auth")
  })

  it("collapses multiple spaces/hyphens", () => {
    expect(deriveBranchName(5, "Some   weird   title")).toBe("5-some-weird-title")
  })

  it("truncates long titles to 50 chars", () => {
    const longTitle = "This is an extremely long title that exceeds the maximum allowed characters for a branch name"
    const branch = deriveBranchName(99, longTitle)
    expect(branch.length).toBeLessThanOrEqual(54) // 99- + 50 chars + possible trailing
  })
})

describe("ensureFeatureBranch logic", () => {
  // These test the LOGIC without actually running git commands

  const BASE_BRANCHES = ["dev", "main", "master"]

  function shouldCreateNewBranch(
    currentBranch: string,
    issueNumber: number,
    branchName: string,
  ): "stay" | "switch-then-create" | "create" {
    // Already on the correct branch for this issue
    if (currentBranch === branchName || currentBranch.startsWith(`${issueNumber}-`)) {
      return "stay"
    }
    // On a different feature branch
    if (!BASE_BRANCHES.includes(currentBranch) && currentBranch !== "") {
      return "switch-then-create"
    }
    // On a base branch
    return "create"
  }

  it("stays on correct branch for same issue", () => {
    expect(shouldCreateNewBranch("42-add-search", 42, "42-add-search")).toBe("stay")
  })

  it("stays on branch starting with issue number", () => {
    expect(shouldCreateNewBranch("42-different-slug", 42, "42-add-search")).toBe("stay")
  })

  it("switches when on different issue's branch", () => {
    expect(shouldCreateNewBranch("13-old-feature", 14, "14-new-feature")).toBe("switch-then-create")
  })

  it("creates directly from base branch", () => {
    expect(shouldCreateNewBranch("main", 42, "42-add-search")).toBe("create")
    expect(shouldCreateNewBranch("dev", 42, "42-add-search")).toBe("create")
  })

  it("creates from empty branch (detached HEAD)", () => {
    expect(shouldCreateNewBranch("", 42, "42-add-search")).toBe("create")
  })
})
