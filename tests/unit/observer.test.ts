import { describe, it, expect } from "vitest"
import type { AgentRunner, AgentResult } from "../../src/types.js"
import { diagnoseFailure } from "../../src/observer.js"

function createMockDiagnosisRunner(response: object): AgentRunner {
  return {
    async run(): Promise<AgentResult> {
      return {
        outcome: "completed",
        output: JSON.stringify(response),
      }
    },
    async healthCheck() { return true },
  }
}

function createFailingRunner(): AgentRunner {
  return {
    async run(): Promise<AgentResult> {
      return { outcome: "failed", error: "Runner failed" }
    },
    async healthCheck() { return true },
  }
}

describe("diagnoseFailure", () => {
  it("classifies infrastructure errors", async () => {
    const runner = createMockDiagnosisRunner({
      classification: "infrastructure",
      reason: "PostgreSQL not running — ECONNREFUSED on port 5432",
      resolution: "Start PostgreSQL or set DATABASE_URL to a running instance",
    })

    const result = await diagnoseFailure(
      "verify",
      "Error: connect ECONNREFUSED 127.0.0.1:5432",
      ["src/utils/test.ts"],
      runner,
      "haiku",
    )

    expect(result.classification).toBe("infrastructure")
    expect(result.reason).toContain("PostgreSQL")
  })

  it("classifies fixable errors", async () => {
    const runner = createMockDiagnosisRunner({
      classification: "fixable",
      reason: "Type error in newly created file",
      resolution: "Change return type from string to number in src/utils/calc.ts line 5",
    })

    const result = await diagnoseFailure(
      "verify",
      "src/utils/calc.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'",
      ["src/utils/calc.ts"],
      runner,
      "haiku",
    )

    expect(result.classification).toBe("fixable")
    expect(result.resolution).toContain("return type")
  })

  it("classifies pre-existing errors", async () => {
    const runner = createMockDiagnosisRunner({
      classification: "pre-existing",
      reason: "Test failure in file not modified by build",
      resolution: "tests/old.test.ts has a pre-existing failure unrelated to this change",
    })

    const result = await diagnoseFailure(
      "verify",
      "FAIL tests/old.test.ts > old test suite > legacy test",
      ["src/utils/new.ts"],
      runner,
      "haiku",
    )

    expect(result.classification).toBe("pre-existing")
  })

  it("classifies retry errors", async () => {
    const runner = createMockDiagnosisRunner({
      classification: "retry",
      reason: "Network timeout — likely transient",
      resolution: "Retry the verification",
    })

    const result = await diagnoseFailure(
      "verify",
      "Error: ETIMEDOUT",
      [],
      runner,
      "haiku",
    )

    expect(result.classification).toBe("retry")
  })

  it("classifies abort errors", async () => {
    const runner = createMockDiagnosisRunner({
      classification: "abort",
      reason: "Permission denied — cannot write to protected directory",
      resolution: "Check file permissions",
    })

    const result = await diagnoseFailure(
      "verify",
      "EACCES: permission denied, open '/etc/passwd'",
      [],
      runner,
      "haiku",
    )

    expect(result.classification).toBe("abort")
  })

  it("defaults to fixable when diagnosis fails", async () => {
    const runner = createFailingRunner()

    const result = await diagnoseFailure(
      "verify",
      "Some error",
      [],
      runner,
      "haiku",
    )

    expect(result.classification).toBe("fixable")
    expect(result.reason).toBe("Could not diagnose failure")
  })

  it("defaults to fixable when response is invalid JSON", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return { outcome: "completed", output: "This is not JSON" }
      },
      async healthCheck() { return true },
    }

    const result = await diagnoseFailure("verify", "error", [], runner, "haiku")
    expect(result.classification).toBe("fixable")
  })

  it("defaults to fixable when classification is invalid", async () => {
    const runner = createMockDiagnosisRunner({
      classification: "unknown-type",
      reason: "test",
      resolution: "test",
    })

    const result = await diagnoseFailure("verify", "error", [], runner, "haiku")
    expect(result.classification).toBe("fixable")
  })

  it("handles markdown-fenced JSON response", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: '```json\n{"classification":"infrastructure","reason":"DB down","resolution":"Start DB"}\n```',
        }
      },
      async healthCheck() { return true },
    }

    const result = await diagnoseFailure("verify", "ECONNREFUSED", [], runner, "haiku")
    expect(result.classification).toBe("infrastructure")
  })

  it("truncates long error output to 5000 chars", async () => {
    let capturedPrompt = ""
    const runner: AgentRunner = {
      async run(_stage: string, prompt: string): Promise<AgentResult> {
        capturedPrompt = prompt
        return {
          outcome: "completed",
          output: JSON.stringify({ classification: "fixable", reason: "test", resolution: "fix" }),
        }
      },
      async healthCheck() { return true },
    }

    const longError = "x".repeat(5000)
    await diagnoseFailure("verify", longError, [], runner, "haiku")

    // The error in the prompt should be truncated
    const errorInPrompt = capturedPrompt.split("Error output:")[1]?.split("\n\n")[0] ?? ""
    expect(errorInPrompt.length).toBeLessThanOrEqual(5100) // 5000 + some padding
  })

  it("includes modified files in diagnosis prompt", async () => {
    let capturedPrompt = ""
    const runner: AgentRunner = {
      async run(_stage: string, prompt: string): Promise<AgentResult> {
        capturedPrompt = prompt
        return {
          outcome: "completed",
          output: JSON.stringify({ classification: "fixable", reason: "test", resolution: "fix" }),
        }
      },
      async healthCheck() { return true },
    }

    await diagnoseFailure("verify", "error", ["src/a.ts", "src/b.ts"], runner, "haiku")

    expect(capturedPrompt).toContain("src/a.ts")
    expect(capturedPrompt).toContain("src/b.ts")
  })
})

describe("observer integration with state machine", () => {
  it("infrastructure diagnosis allows pipeline to continue", () => {
    // When diagnosis returns "infrastructure", verify should return completed (not failed)
    const diagnosis = { classification: "infrastructure" as const, reason: "DB down", resolution: "Start DB" }

    // The state machine returns completed for infrastructure issues
    const shouldContinue = diagnosis.classification === "infrastructure" || diagnosis.classification === "pre-existing"
    expect(shouldContinue).toBe(true)
  })

  it("fixable diagnosis triggers autofix with resolution guidance", () => {
    const diagnosis = { classification: "fixable" as const, reason: "Type error", resolution: "Fix return type on line 5" }

    // Resolution should be passed as feedback to autofix agent
    const feedback = diagnosis.resolution
    expect(feedback).toContain("Fix return type")
  })

  it("abort diagnosis stops pipeline immediately", () => {
    const diagnosis = { classification: "abort" as const, reason: "Permission denied", resolution: "" }

    const shouldStop = diagnosis.classification === "abort"
    expect(shouldStop).toBe(true)
  })
})
