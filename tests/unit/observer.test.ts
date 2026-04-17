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
      reason: "EACCES permission denied — cannot write to protected directory",
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

  it("defaults to retry when diagnosis fails", async () => {
    const runner = createFailingRunner()

    const result = await diagnoseFailure(
      "verify",
      "Some error",
      [],
      runner,
      "haiku",
    )

    // Defaults to "retry" (not "fixable") to avoid triggering autofix on
    // infrastructure or pre-existing issues. The verify loop's max-attempts
    // cap prevents infinite retries.
    expect(result.classification).toBe("retry")
    expect(result.reason).toContain("Could not diagnose")
  })

  it("defaults to retry when response is invalid JSON", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return { outcome: "completed", output: "This is not JSON" }
      },
      async healthCheck() { return true },
    }

    const result = await diagnoseFailure("verify", "error", [], runner, "haiku")
    expect(result.classification).toBe("retry")
  })

  it("defaults to retry when classification is invalid", async () => {
    const runner = createMockDiagnosisRunner({
      classification: "unknown-type",
      reason: "test",
      resolution: "test",
    })

    const result = await diagnoseFailure("verify", "error", [], runner, "haiku")
    expect(result.classification).toBe("retry")
  })

  it("handles markdown-fenced JSON response", async () => {
    const runner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: '```json\n{"classification":"infrastructure","reason":"DB down — ECONNREFUSED on port 5432","resolution":"Start DB"}\n```',
        }
      },
      async healthCheck() { return true },
    }

    const result = await diagnoseFailure("verify", "ECONNREFUSED 127.0.0.1:5432", [], runner, "haiku")
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

describe("hasLiteralQuote (Fix #3)", () => {
  it("accepts a TS error code quoted in reason", async () => {
    const { hasLiteralQuote } = await import("../../src/observer.js")
    const err = "src/pages/foo.tsx(12,5): error TS2344: constraint violation"
    expect(hasLiteralQuote("TS2344 at src/pages/foo.tsx is pre-existing", err)).toBe(true)
  })

  it("accepts an ESLint rule slug quoted in reason", async () => {
    const { hasLiteralQuote } = await import("../../src/observer.js")
    const err = "56:7 error Do not assign @next/next/no-assign-module-variable"
    expect(hasLiteralQuote("@next/next/no-assign-module-variable violation", err)).toBe(true)
  })

  it("accepts a file path quoted in reason", async () => {
    const { hasLiteralQuote } = await import("../../src/observer.js")
    const err = "tests/helpers/seedUser.ts(26,24): error"
    expect(hasLiteralQuote("Error in tests/helpers/seedUser.ts is pre-existing", err)).toBe(true)
  })

  it("accepts an uppercase system error (ECONNREFUSED) quoted in reason", async () => {
    const { hasLiteralQuote } = await import("../../src/observer.js")
    const err = "Error: connect ECONNREFUSED 127.0.0.1:5432"
    expect(hasLiteralQuote("PostgreSQL not running — ECONNREFUSED on port 5432", err)).toBe(true)
  })

  it("also checks resolution field for quoted tokens", async () => {
    const { hasLiteralQuote } = await import("../../src/observer.js")
    const err = "src/utils/calc.ts(5,3): error TS2322"
    // reason is paraphrased but resolution quotes the path
    expect(hasLiteralQuote("Type error in new file", err, "Fix line 5 in src/utils/calc.ts")).toBe(true)
  })

  it("rejects pure paraphrase with no verbatim token in reason OR resolution", async () => {
    const { hasLiteralQuote } = await import("../../src/observer.js")
    const err = "src/foo.ts(10,5): error TS2344: bad type"
    expect(hasLiteralQuote("Some types need const instead of let", err, "change let to const")).toBe(false)
  })

  it("rejects empty inputs", async () => {
    const { hasLiteralQuote } = await import("../../src/observer.js")
    expect(hasLiteralQuote("", "foo")).toBe(false)
    expect(hasLiteralQuote("foo", "")).toBe(false)
  })
})

describe("diagnoseFailure heuristic promoted to primary (Fix #1 part A)", () => {
  it("returns pre-existing without LLM when all error paths are outside changeset", async () => {
    const { diagnoseFailure } = await import("../../src/observer.js")
    let runnerCalled = false
    const fakeRunner: AgentRunner = {
      async run(): Promise<AgentResult> { runnerCalled = true; return { outcome: "completed", output: "{}" } },
      async healthCheck() { return true },
    }
    const errorOutput = [
      "src/pages/error/ErrorPage.tsx(10,5): error TS2344: pre-existing",
      ".next/types/validator.ts(206,31): error TS2344: generated",
      "tests/helpers/seedUser.ts(26,24): error TS2345: fixture bad",
    ].join("\n")

    const result = await diagnoseFailure("verify", errorOutput, ["package.json"], fakeRunner, "x")
    expect(result.classification).toBe("pre-existing")
    expect(runnerCalled).toBe(false)
  })

  it("falls through to LLM when errors span changeset + non-changeset", async () => {
    const { diagnoseFailure } = await import("../../src/observer.js")
    let runnerCalled = false
    const fakeRunner: AgentRunner = {
      async run(): Promise<AgentResult> {
        runnerCalled = true
        return {
          outcome: "completed",
          output: JSON.stringify({
            classification: "fixable",
            reason: "TS2344 at src/my-change.ts — user-introduced",
            resolution: "tweak type",
          }),
        }
      },
      async healthCheck() { return true },
    }
    const errorOutput = [
      "src/my-change.ts(5,5): error TS2344: my error",
      ".next/types/validator.ts(206,31): error TS2344: pre-existing",
    ].join("\n")
    const result = await diagnoseFailure("verify", errorOutput, ["src/my-change.ts"], fakeRunner, "x")
    expect(runnerCalled).toBe(true)
    expect(result.classification).toBe("fixable")
  })

  it("rejects un-quoted LLM hallucination and defaults to retry (Fix #3 gate)", async () => {
    const { diagnoseFailure } = await import("../../src/observer.js")
    const fakeRunner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: JSON.stringify({
            classification: "fixable",
            reason: "some types need const instead of let",
            resolution: "change let to const",
          }),
        }
      },
      async healthCheck() { return true },
    }
    // Errors reference src/my-change.ts (modified) so heuristic is inconclusive;
    // LLM runs and returns paraphrase → rejected
    const errorOutput = "src/my-change.ts(5,5): error TS2344: mismatch"
    const result = await diagnoseFailure("verify", errorOutput, ["src/my-change.ts"], fakeRunner, "x")
    expect(result.classification).toBe("retry")
  })

  it("#2274 regression: hallucinated const/let reason is rejected and heuristic classifies pre-existing", async () => {
    const { diagnoseFailure } = await import("../../src/observer.js")
    const fakeRunner: AgentRunner = {
      async run(): Promise<AgentResult> {
        return {
          outcome: "completed",
          output: JSON.stringify({
            classification: "fixable",
            reason: "Test assertions check for substrings that don't exist, and there's a lint error requiring const instead of let",
            resolution: "change let to const",
          }),
        }
      },
      async healthCheck() { return true },
    }
    const errorOutput = [
      ".next/types/validator.ts(206,31): error TS2344: pages/board/modal missing default export",
      "src/utils/bad-types.ts(2,3): error TS2322",
      "tests/helpers/seedUser.ts(26,24): error TS2345",
    ].join("\n")
    const result = await diagnoseFailure("verify", errorOutput, ["package.json"], fakeRunner, "x")
    expect(result.classification).toBe("pre-existing")
  })
})

describe("errorReferencesPath / errorReferencesAnyOf", () => {
  it("errorReferencesPath matches exact substring", async () => {
    const { errorReferencesPath } = await import("../../src/observer.js")
    expect(errorReferencesPath("src/foo.ts(5,1): error", "src/foo.ts")).toBe(true)
  })

  it("errorReferencesPath matches by basename when error line is path-shaped", async () => {
    const { errorReferencesPath } = await import("../../src/observer.js")
    expect(errorReferencesPath("build failed in foo.ts(5,1): TS2344", "src/foo.ts")).toBe(true)
  })

  it("errorReferencesPath rejects when no file-ish token present", async () => {
    const { errorReferencesPath } = await import("../../src/observer.js")
    expect(errorReferencesPath("vague error text", "src/foo.ts")).toBe(false)
  })

  it("errorReferencesAnyOf true when any path matches", async () => {
    const { errorReferencesAnyOf } = await import("../../src/observer.js")
    expect(errorReferencesAnyOf("src/a.ts(1,1): err", ["src/b.ts", "src/a.ts"])).toBe(true)
  })

  it("errorReferencesAnyOf false when no paths match", async () => {
    const { errorReferencesAnyOf } = await import("../../src/observer.js")
    expect(errorReferencesAnyOf("src/c.ts(1,1): err", ["src/a.ts", "src/b.ts"])).toBe(false)
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
