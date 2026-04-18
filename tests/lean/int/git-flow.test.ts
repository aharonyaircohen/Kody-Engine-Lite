import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import {
  ensureFeatureBranch,
  deriveBranchName,
  hasUncommittedChanges,
  getCurrentBranch,
  UncommittedChangesError,
} from "../../../src-v2/branch.js"
import {
  commitAndPush,
  hasCommitsAhead,
  listChangedFiles,
} from "../../../src-v2/commit.js"

interface TempRepo {
  workdir: string
  remote: string
  cleanup: () => void
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    cwd,
    env: {
      ...process.env,
      HUSKY: "0",
      SKIP_HOOKS: "1",
      GIT_AUTHOR_NAME: "Kody Test",
      GIT_AUTHOR_EMAIL: "test@kody",
      GIT_COMMITTER_NAME: "Kody Test",
      GIT_COMMITTER_EMAIL: "test@kody",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

function makeTempRepo(): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-lean-int-"))
  const remote = path.join(root, "remote.git")
  const workdir = path.join(root, "work")
  fs.mkdirSync(workdir, { recursive: true })

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" })
  execFileSync("git", ["init", "--initial-branch=main", workdir], { stdio: "pipe" })
  git(workdir, ["remote", "add", "origin", remote])
  fs.writeFileSync(path.join(workdir, "README.md"), "# initial\n")
  git(workdir, ["add", "."])
  git(workdir, ["commit", "--no-gpg-sign", "-m", "initial"])
  git(workdir, ["push", "-u", "origin", "main"])

  return {
    workdir,
    remote,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

describe("integration: git flow", () => {
  let repo: TempRepo

  beforeEach(() => { repo = makeTempRepo() })
  afterEach(() => { repo.cleanup() })

  it("creates a feature branch from main", () => {
    const result = ensureFeatureBranch(123, "Add cool thing", "main", repo.workdir)
    expect(result.branch).toBe(deriveBranchName(123, "Add cool thing"))
    expect(result.created).toBe(true)
    expect(getCurrentBranch(repo.workdir)).toBe(result.branch)
  })

  it("re-enters existing feature branch idempotently", () => {
    ensureFeatureBranch(7, "X", "main", repo.workdir)
    git(repo.workdir, ["checkout", "main"])
    const second = ensureFeatureBranch(7, "X", "main", repo.workdir)
    expect(second.created).toBe(false)
    expect(getCurrentBranch(repo.workdir)).toBe(second.branch)
  })

  it("refuses to run on a branch with uncommitted changes to tracked files", () => {
    ensureFeatureBranch(8, "Y", "main", repo.workdir)
    fs.writeFileSync(path.join(repo.workdir, "README.md"), "# initial\nWIP edit\n")
    expect(hasUncommittedChanges(repo.workdir)).toBe(true)
    expect(() => ensureFeatureBranch(8, "Y", "main", repo.workdir))
      .toThrow(UncommittedChangesError)
  })

  it("ignores untracked files (not protectable WIP)", () => {
    ensureFeatureBranch(81, "Z", "main", repo.workdir)
    fs.writeFileSync(path.join(repo.workdir, "scratch.tmp"), "junk")
    expect(hasUncommittedChanges(repo.workdir)).toBe(false)
    expect(() => ensureFeatureBranch(81, "Z", "main", repo.workdir)).not.toThrow()
  })

  it("commits allowed files and pushes to remote", () => {
    const branch = ensureFeatureBranch(9, "Edit Z", "main", repo.workdir).branch
    fs.writeFileSync(path.join(repo.workdir, "src.txt"), "content")
    fs.mkdirSync(path.join(repo.workdir, "node_modules"), { recursive: true })
    fs.writeFileSync(path.join(repo.workdir, "node_modules/x.txt"), "should be excluded")

    expect(listChangedFiles(repo.workdir).length).toBeGreaterThan(0)

    const result = commitAndPush(branch, "feat: add stuff", repo.workdir)
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.message).toBe("feat: add stuff")
    expect(hasCommitsAhead(branch, "main", repo.workdir)).toBe(true)

    const log = git(repo.workdir, ["log", "--oneline", "-1"])
    expect(log).toMatch(/feat: add stuff/)

    const trackedFiles = git(repo.workdir, ["ls-files"]).split("\n")
    expect(trackedFiles).toContain("src.txt")
    expect(trackedFiles.find((f) => f.startsWith("node_modules/"))).toBeUndefined()
  })

  it("normalizes commit prefix when missing", () => {
    const branch = ensureFeatureBranch(10, "Edit W", "main", repo.workdir).branch
    fs.writeFileSync(path.join(repo.workdir, "x.txt"), "y")
    const result = commitAndPush(branch, "just an edit", repo.workdir)
    expect(result.message.startsWith("chore: ")).toBe(true)
  })

  it("returns committed=false when only forbidden files changed", () => {
    const branch = ensureFeatureBranch(11, "Only excluded", "main", repo.workdir).branch
    fs.mkdirSync(path.join(repo.workdir, ".kody-lean"), { recursive: true })
    fs.writeFileSync(path.join(repo.workdir, ".kody-lean/run.jsonl"), "x")
    const result = commitAndPush(branch, "feat: bogus", repo.workdir)
    expect(result.committed).toBe(false)
    expect(hasCommitsAhead(branch, "main", repo.workdir)).toBe(false)
  })
})
