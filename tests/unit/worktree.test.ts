import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execFileSync } from "child_process"
import { createWorktree, removeWorktree, mergeSubTaskBranch, worktreePath, getWorktreeChangedFiles } from "../../src/worktree.js"

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

describe("worktree utilities", () => {
  let repoDir: string

  beforeEach(() => {
    // Create a temp git repo
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-wt-test-"))
    git(["init"], repoDir)
    git(["config", "user.email", "test@test.com"], repoDir)
    git(["config", "user.name", "Test"], repoDir)
    // Initial commit so HEAD exists
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test")
    git(["add", "."], repoDir)
    git(["commit", "-m", "init"], repoDir)
  })

  afterEach(() => {
    // Cleanup worktrees before removing repo
    try {
      git(["worktree", "prune"], repoDir)
    } catch { /* ignore */ }
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  describe("worktreePath", () => {
    it("constructs path under /tmp/kody-worktrees", () => {
      const p = worktreePath("task-123", "part-1")
      expect(p).toBe("/tmp/kody-worktrees/task-123/part-1")
    })
  })

  describe("createWorktree / removeWorktree", () => {
    it("creates and removes a worktree", () => {
      const wtPath = path.join(os.tmpdir(), `kody-wt-test-wt-${Date.now()}`)

      createWorktree(repoDir, wtPath, "test-branch")

      // Worktree should exist and have files
      expect(fs.existsSync(wtPath)).toBe(true)
      expect(fs.existsSync(path.join(wtPath, "README.md"))).toBe(true)

      // Branch should exist
      const branches = git(["branch"], repoDir)
      expect(branches).toContain("test-branch")

      // Remove
      removeWorktree(repoDir, wtPath)
      expect(fs.existsSync(wtPath)).toBe(false)
    })
  })

  describe("mergeSubTaskBranch", () => {
    it("merges a branch cleanly", () => {
      // Create a branch with a change
      git(["checkout", "-b", "feature-branch"], repoDir)
      fs.writeFileSync(path.join(repoDir, "feature.ts"), "export const x = 1")
      git(["add", "."], repoDir)
      git(["commit", "-m", "feature"], repoDir)
      git(["checkout", "-"], repoDir) // back to main/master

      const result = mergeSubTaskBranch("feature-branch", repoDir)
      expect(result).toBe("clean")

      // File should exist after merge
      expect(fs.existsSync(path.join(repoDir, "feature.ts"))).toBe(true)
    })

    it("detects merge conflicts", () => {
      const mainBranch = git(["branch", "--show-current"], repoDir)

      // Create conflicting changes on two branches
      fs.writeFileSync(path.join(repoDir, "shared.ts"), "main content")
      git(["add", "."], repoDir)
      git(["commit", "-m", "main change"], repoDir)

      git(["checkout", "-b", "conflict-branch", "HEAD~1"], repoDir)
      fs.writeFileSync(path.join(repoDir, "shared.ts"), "branch content")
      git(["add", "."], repoDir)
      git(["commit", "-m", "branch change"], repoDir)

      git(["checkout", mainBranch], repoDir)

      const result = mergeSubTaskBranch("conflict-branch", repoDir)
      expect(result).toBe("conflict")
    })
  })

  describe("getWorktreeChangedFiles", () => {
    it("returns changed files (staged)", () => {
      fs.writeFileSync(path.join(repoDir, "new-file.ts"), "content")
      git(["add", "new-file.ts"], repoDir)
      const changed = getWorktreeChangedFiles(repoDir)
      expect(changed).toContain("new-file.ts")
    })

    it("returns empty for clean repo", () => {
      const changed = getWorktreeChangedFiles(repoDir)
      expect(changed).toEqual([])
    })
  })
})
