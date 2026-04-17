/**
 * Fix #2 — verify autofix pre-check + scope-guard prompt.
 *
 * Uses vitest's module mocks to stub out the gate, diagnosis, and agent
 * stages, then asserts verify.ts's control flow under different error
 * scenarios.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execFileSync } from "child_process"

function tmpProject(): { projectDir: string; taskDir: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-autofix-"))
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
    input: { dryRun: false, skipTests: false, local: true },
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
    maxRetries: 2,
    retryWithAgent: "autofix",
  } as unknown as import("../../src/types.js").StageDefinition
}

describe("executeVerifyWithAutofix pre-check (Fix #2)", () => {
  let projectDir: string
  let taskDir: string

  beforeEach(() => {
    ({ projectDir, taskDir } = tmpProject())
    // verify.md needs to exist for the diagnosis to read it
    fs.writeFileSync(
      path.join(taskDir, "verify.md"),
      "# Verification Report\n## Result: FAIL\n\n## Errors\n- [typecheck] .next/types/validator.ts(206,31): error TS2344: pre-existing\n- [typecheck] src/utils/bad-types.ts(2,3): error TS2322: pre-existing\n",
    )
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    vi.resetModules()
    vi.clearAllMocks()
  })

  it("skips autofix when no errors reference any file in changeset", async () => {
    vi.doMock("../../src/stages/gate.js", () => ({
      executeGateStage: () => ({ outcome: "failed", retries: 0 }),
    }))
    vi.doMock("../../src/observer.js", () => ({
      getModifiedFiles: () => ["package.json"],
      errorReferencesAnyOf: () => false, // nothing matches changeset
      diagnoseFailure: async () => ({
        classification: "fixable",
        reason: "TS2344 at .next/types/validator.ts",
        resolution: "x",
      }),
    }))
    let agentRan = false
    vi.doMock("../../src/stages/agent.js", () => ({
      executeAgentStage: async () => { agentRan = true; return { outcome: "completed" } },
    }))
    vi.doMock("../../src/pipeline/runner-selection.js", () => ({
      getRunnerForStage: () => ({ run: async () => ({ outcome: "completed", output: "" }) }),
    }))
    vi.doMock("../../src/config.js", async () => ({
      ...(await vi.importActual<typeof import("../../src/config.js")>("../../src/config.js")),
      getProjectConfig: () => ({
        quality: { typecheck: "true", testUnit: "true", lintFix: "", formatFix: "" },
        agent: { defaultRunner: "claude", modelMap: { cheap: "claude/x", mid: "claude/x", strong: "claude/x" } },
      }),
    }))

    const { executeVerifyWithAutofix } = await import("../../src/stages/verify.js")
    const result = await executeVerifyWithAutofix(makeCtx(projectDir, taskDir), makeDef())

    expect(result.outcome).toBe("completed")
    expect(result.error).toMatch(/outside changeset/)
    expect(agentRan).toBe(false)
  })

  it("runs autofix when at least one error references a changeset file", async () => {
    let gateCalls = 0
    vi.doMock("../../src/stages/gate.js", () => ({
      executeGateStage: () => {
        gateCalls += 1
        // Fail first, pass second (autofix "fixed" it)
        return gateCalls === 1
          ? { outcome: "failed", retries: 0 }
          : { outcome: "completed", retries: 0 }
      },
    }))
    vi.doMock("../../src/observer.js", () => ({
      getModifiedFiles: () => ["src/my-change.ts"],
      errorReferencesAnyOf: (line: string, paths: string[]) => paths.some((p) => line.includes(p)),
      diagnoseFailure: async () => ({
        classification: "fixable",
        reason: "TS2344 at src/my-change.ts",
        resolution: "fix the type",
      }),
    }))
    let agentRan = false
    let agentFeedback = ""
    vi.doMock("../../src/stages/agent.js", () => ({
      executeAgentStage: async (ctx: import("../../src/types.js").PipelineContext) => {
        agentRan = true
        agentFeedback = ctx.input.feedback ?? ""
        return { outcome: "completed" }
      },
    }))
    vi.doMock("../../src/pipeline/runner-selection.js", () => ({
      getRunnerForStage: () => ({ run: async () => ({ outcome: "completed", output: "" }) }),
    }))
    vi.doMock("../../src/config.js", async () => ({
      ...(await vi.importActual<typeof import("../../src/config.js")>("../../src/config.js")),
      getProjectConfig: () => ({
        quality: { typecheck: "true", testUnit: "true", lintFix: "", formatFix: "" },
        agent: { defaultRunner: "claude", modelMap: { cheap: "claude/x", mid: "claude/x", strong: "claude/x" } },
      }),
    }))

    // Rewrite verify.md to include a src/my-change.ts error so pre-check passes
    fs.writeFileSync(
      path.join(taskDir, "verify.md"),
      "## Errors\n- [typecheck] src/my-change.ts(5,1): error TS2344\n",
    )

    const { executeVerifyWithAutofix } = await import("../../src/stages/verify.js")
    const result = await executeVerifyWithAutofix(makeCtx(projectDir, taskDir), makeDef())

    expect(result.outcome).toBe("completed")
    expect(agentRan).toBe(true)
    // Scope-guard text present in feedback
    expect(agentFeedback).toContain("SCOPE RESTRICTION")
    expect(agentFeedback).toContain("src/my-change.ts")
  })

  it("autofix feedback contains the scope-guard block listing all modified files", async () => {
    vi.doMock("../../src/stages/gate.js", () => ({
      executeGateStage: () => ({ outcome: "failed", retries: 0 }),
    }))
    vi.doMock("../../src/observer.js", () => ({
      getModifiedFiles: () => ["src/a.ts", "src/b.ts"],
      errorReferencesAnyOf: () => true,
      diagnoseFailure: async () => ({
        classification: "fixable",
        reason: "TS2344 at src/a.ts",
        resolution: "fix it",
      }),
    }))
    let agentFeedback = ""
    vi.doMock("../../src/stages/agent.js", () => ({
      executeAgentStage: async (ctx: import("../../src/types.js").PipelineContext) => {
        agentFeedback = ctx.input.feedback ?? ""
        return { outcome: "completed" }
      },
    }))
    vi.doMock("../../src/pipeline/runner-selection.js", () => ({
      getRunnerForStage: () => ({ run: async () => ({ outcome: "completed", output: "" }) }),
    }))
    vi.doMock("../../src/config.js", async () => ({
      ...(await vi.importActual<typeof import("../../src/config.js")>("../../src/config.js")),
      getProjectConfig: () => ({
        quality: { typecheck: "true", testUnit: "true", lintFix: "", formatFix: "" },
        agent: { defaultRunner: "claude", modelMap: { cheap: "claude/x", mid: "claude/x", strong: "claude/x" } },
      }),
    }))

    fs.writeFileSync(
      path.join(taskDir, "verify.md"),
      "## Errors\n- [typecheck] src/a.ts(1,1): TS2344\n",
    )

    const { executeVerifyWithAutofix } = await import("../../src/stages/verify.js")
    await executeVerifyWithAutofix(makeCtx(projectDir, taskDir), {
      ...makeDef(),
      maxRetries: 1,
    })

    expect(agentFeedback).toContain("SCOPE RESTRICTION")
    expect(agentFeedback).toContain("src/a.ts")
    expect(agentFeedback).toContain("src/b.ts")
  })
})
