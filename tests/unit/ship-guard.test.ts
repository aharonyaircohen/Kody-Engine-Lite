import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"

import {
  shouldFailFixModeShip,
  detectSourceChangesSinceRef,
  isKodyArtifactPath,
} from "../../src/stages/ship.js"

describe("ship guard: shouldFailFixModeShip", () => {
  it("fix + non-empty feedback + no source change → fail", () => {
    expect(shouldFailFixModeShip("fix", "Add a ping() method", false)).toBe(true)
  })

  it("fix-ci + non-empty feedback + no source change → fail", () => {
    expect(shouldFailFixModeShip("fix-ci", "CI failed with TS2345", false)).toBe(true)
  })

  it("fix + non-empty feedback + source changed → pass", () => {
    expect(shouldFailFixModeShip("fix", "Add a ping() method", true)).toBe(false)
  })

  it("fix + empty/whitespace feedback → never fail (fast path preserved)", () => {
    expect(shouldFailFixModeShip("fix", "", false)).toBe(false)
    expect(shouldFailFixModeShip("fix", undefined, false)).toBe(false)
    expect(shouldFailFixModeShip("fix", "   \n  ", false)).toBe(false)
  })

  it("non-fix commands never trigger the guard", () => {
    expect(shouldFailFixModeShip("full", "Some feedback", false)).toBe(false)
    expect(shouldFailFixModeShip("rerun", "Some feedback", false)).toBe(false)
    expect(shouldFailFixModeShip(undefined, "Some feedback", false)).toBe(false)
  })
})

describe("detectSourceChangesSinceRef", () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-ship-guard-test-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, stdio: "pipe" })
    git("init", "-q", "-b", "main")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    // Seed commit with a source file (simulates pre-existing PR content)
    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const a = 1\n")
    git("add", ".")
    git("commit", "-q", "--no-gpg-sign", "-m", "seed source")
  })

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  it("returns false when no commits added since ref (the no-op fix case)", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir, encoding: "utf-8", stdio: "pipe",
    }).trim()
    // No new commits — a fix run that produced nothing.
    expect(detectSourceChangesSinceRef(repoDir, head)).toBe(false)
  })

  it("returns true when a source file changed since ref", () => {
    const ref = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir, encoding: "utf-8", stdio: "pipe",
    }).trim()
    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const a = 2\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" })
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "real fix"], {
      cwd: repoDir, stdio: "pipe",
    })
    expect(detectSourceChangesSinceRef(repoDir, ref)).toBe(true)
  })

  it("ignores .kody/ artifacts — pure Kody task artifact commit is not a source change", () => {
    const ref = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir, encoding: "utf-8", stdio: "pipe",
    }).trim()
    fs.mkdirSync(path.join(repoDir, ".kody", "tasks", "t1"), { recursive: true })
    fs.writeFileSync(path.join(repoDir, ".kody", "tasks", "t1", "task.md"), "x")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" })
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "kody artifacts"], {
      cwd: repoDir, stdio: "pipe",
    })
    expect(detectSourceChangesSinceRef(repoDir, ref)).toBe(false)
  })

  it("ignores .kody-engine/ artifacts — engine bookkeeping doesn't count as source", () => {
    const ref = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir, encoding: "utf-8", stdio: "pipe",
    }).trim()
    fs.mkdirSync(path.join(repoDir, ".kody-engine", ".kody-engine"), { recursive: true })
    fs.writeFileSync(path.join(repoDir, ".kody-engine", ".kody-engine", "event-log.json"), "{}")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" })
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "engine event log"], {
      cwd: repoDir, stdio: "pipe",
    })
    expect(detectSourceChangesSinceRef(repoDir, ref)).toBe(false)
  })

  it("mixed commit (engine artifact + source) is STILL a source change", () => {
    const ref = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir, encoding: "utf-8", stdio: "pipe",
    }).trim()
    fs.mkdirSync(path.join(repoDir, ".kody-engine"), { recursive: true })
    fs.writeFileSync(path.join(repoDir, ".kody-engine", "log.json"), "{}")
    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const a = 2\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" })
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", "real fix + log bookkeeping"], {
      cwd: repoDir, stdio: "pipe",
    })
    expect(detectSourceChangesSinceRef(repoDir, ref)).toBe(true)
  })

  it("safety-net: unknown ref → returns true (don't block ship)", () => {
    expect(detectSourceChangesSinceRef(repoDir, "0000000000000000000000000000000000000000")).toBe(true)
  })
})

describe("isKodyArtifactPath", () => {
  it("recognizes .kody/ paths", () => {
    expect(isKodyArtifactPath(".kody/tasks/t1/plan.md")).toBe(true)
    expect(isKodyArtifactPath(".kody/memory/diary.jsonl")).toBe(true)
  })

  it("recognizes .kody-engine/ paths", () => {
    expect(isKodyArtifactPath(".kody-engine/.kody-engine/event-log.json")).toBe(true)
    expect(isKodyArtifactPath(".kody-engine/foo")).toBe(true)
  })

  it("does NOT match real source paths", () => {
    expect(isKodyArtifactPath("src/app/api/dashboard/route.ts")).toBe(false)
    expect(isKodyArtifactPath("tests/int/feature.test.ts")).toBe(false)
    expect(isKodyArtifactPath("package.json")).toBe(false)
  })

  it("does NOT match substring-ish matches (prefix only)", () => {
    // Anchored: only real prefixes count
    expect(isKodyArtifactPath("docs/.kody/guide.md")).toBe(false)
    expect(isKodyArtifactPath("tests/.kody-engine-helpers.ts")).toBe(false)
  })
})
