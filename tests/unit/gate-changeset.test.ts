/**
 * Fix #1 (Part B) — gate partitions errors by changeset.
 *
 * Strategy: mock runQualityGates to return a controlled error list, and
 * mock getModifiedFiles to return a controlled changeset. Assert the gate
 * passes/fails correctly and writes the right sections into verify.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execFileSync } from "child_process"

function tmpTask(): { projectDir: string; taskDir: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-gate-"))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: projectDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "t"], { cwd: projectDir, stdio: "pipe" })
  const taskDir = path.join(projectDir, ".kody/tasks/test-task")
  fs.mkdirSync(taskDir, { recursive: true })
  return { projectDir, taskDir }
}

function makeCtx(projectDir: string, taskDir: string) {
  return {
    taskId: "test-task",
    projectDir,
    taskDir,
    input: { dryRun: false, skipTests: false },
    tools: {},
    sessions: {},
    runners: {},
  } as unknown as import("../../src/types.js").PipelineContext
}

function makeDef() {
  return {
    name: "verify",
    type: "gate",
    modelTier: "cheap",
    timeout: 60_000,
  } as unknown as import("../../src/types.js").StageDefinition
}

describe("executeGateStage — changeset partition (Fix #1)", () => {
  let projectDir: string
  let taskDir: string

  beforeEach(() => {
    ({ projectDir, taskDir } = tmpTask())
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it("passes when verifyResult.pass is true regardless of changeset", async () => {
    vi.doMock("../../src/verify-runner.js", () => ({
      runQualityGates: () => ({ pass: true, errors: [], summary: [], rawOutputs: [] }),
    }))
    const { executeGateStage } = await import("../../src/stages/gate.js")
    const result = executeGateStage(makeCtx(projectDir, taskDir), makeDef())
    expect(result.outcome).toBe("completed")
  })

  it("fails when all errors reference files in the changeset", async () => {
    vi.doMock("../../src/verify-runner.js", () => ({
      runQualityGates: () => ({
        pass: false,
        errors: ["[typecheck] src/my-change.ts(5,1): error TS2344: bad"],
        summary: [],
        rawOutputs: [],
      }),
    }))
    vi.doMock("../../src/observer.js", () => ({
      getModifiedFiles: () => ["src/my-change.ts"],
      errorReferencesAnyOf: (line: string, paths: string[]) => paths.some((p) => line.includes(p)),
    }))
    const { executeGateStage } = await import("../../src/stages/gate.js")
    const result = executeGateStage(makeCtx(projectDir, taskDir), makeDef())
    expect(result.outcome).toBe("failed")
    const verifyMd = fs.readFileSync(path.join(taskDir, "verify.md"), "utf-8")
    expect(verifyMd).toMatch(/## Errors \(in changeset\)/)
    expect(verifyMd).not.toContain("Skipped pre-existing")
  })

  it("passes with skip-report when ALL errors are in pre-existing files", async () => {
    vi.doMock("../../src/verify-runner.js", () => ({
      runQualityGates: () => ({
        pass: false,
        errors: [
          "[typecheck] src/pages/error/ErrorPage.tsx(10,5): error TS2344",
          "[typecheck] .next/types/validator.ts(206,31): error TS2344",
          "[typecheck] tests/helpers/seedUser.ts(26,24): error TS2345",
        ],
        summary: ["142 problems"],
        rawOutputs: [],
      }),
    }))
    vi.doMock("../../src/observer.js", () => ({
      getModifiedFiles: () => ["package.json"],
      errorReferencesAnyOf: (line: string, paths: string[]) => paths.some((p) => line.includes(p)),
    }))
    const { executeGateStage } = await import("../../src/stages/gate.js")
    const result = executeGateStage(makeCtx(projectDir, taskDir), makeDef())

    expect(result.outcome).toBe("completed")
    const verifyMd = fs.readFileSync(path.join(taskDir, "verify.md"), "utf-8")
    expect(verifyMd).toContain("(pre-existing errors skipped)")
    expect(verifyMd).toContain("## Skipped pre-existing errors")
    expect(verifyMd).toContain("ErrorPage.tsx")
    expect(verifyMd).toContain(".next/types/validator.ts")
  })

  it("fails when changeset errors are mixed with pre-existing", async () => {
    vi.doMock("../../src/verify-runner.js", () => ({
      runQualityGates: () => ({
        pass: false,
        errors: [
          "[typecheck] src/my-change.ts(5,1): error TS2344",
          "[typecheck] .next/types/validator.ts(206,31): error TS2344",
        ],
        summary: [],
        rawOutputs: [],
      }),
    }))
    vi.doMock("../../src/observer.js", () => ({
      getModifiedFiles: () => ["src/my-change.ts"],
      errorReferencesAnyOf: (line: string, paths: string[]) => paths.some((p) => line.includes(p)),
    }))
    const { executeGateStage } = await import("../../src/stages/gate.js")
    const result = executeGateStage(makeCtx(projectDir, taskDir), makeDef())

    expect(result.outcome).toBe("failed")
    const verifyMd = fs.readFileSync(path.join(taskDir, "verify.md"), "utf-8")
    expect(verifyMd).toContain("## Errors (in changeset)")
    expect(verifyMd).toContain("## Skipped pre-existing errors")
    expect(verifyMd).toContain("src/my-change.ts")
    expect(verifyMd).toContain(".next/types/validator.ts")
  })

  it("treats errors without any file path as changeset-bound (safe default)", async () => {
    vi.doMock("../../src/verify-runner.js", () => ({
      runQualityGates: () => ({
        pass: false,
        errors: ["[test] generic failure with no file", "[lint] foo.ts(1,1): error some-rule"],
        summary: [],
        rawOutputs: [],
      }),
    }))
    vi.doMock("../../src/observer.js", () => ({
      getModifiedFiles: () => ["package.json"],
      errorReferencesAnyOf: (line: string, paths: string[]) => paths.some((p) => line.includes(p)),
    }))
    const { executeGateStage } = await import("../../src/stages/gate.js")
    const result = executeGateStage(makeCtx(projectDir, taskDir), makeDef())

    // The generic error has no path → stays in changeset → fail
    expect(result.outcome).toBe("failed")
    const verifyMd = fs.readFileSync(path.join(taskDir, "verify.md"), "utf-8")
    expect(verifyMd).toContain("## Errors (in changeset)")
    expect(verifyMd).toContain("generic failure with no file")
  })
})
