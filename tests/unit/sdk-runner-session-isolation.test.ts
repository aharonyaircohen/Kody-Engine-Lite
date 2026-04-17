import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ─── Mock @anthropic-ai/claude-agent-sdk BEFORE importing the runner ──────────
// The SDK `query` function is what we need to verify our runner is calling
// correctly. We replace it with a controllable async generator + a spy that
// captures the options it received.
const queryCalls: Array<Record<string, unknown>> = []
const makeMockQuery =
  (messages: unknown[] = [{ type: "result", subtype: "success", result: "ok" }]) =>
  (...args: unknown[]) => {
    // SDK call shape: query({ prompt, options }) — capture the options
    const firstArg = args[0] as { options?: Record<string, unknown> }
    queryCalls.push(firstArg.options ?? {})
    return (async function* () {
      for (const m of messages) yield m
    })()
  }

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => makeMockQuery()(...args),
}))

// Now safe to import the runner
import { createSdkRunner } from "../../src/agent-runner.js"

describe("SDK runner — session-resume isolation (regression guard)", () => {
  let tmpDir: string

  beforeEach(() => {
    queryCalls.length = 0
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-sdk-iso-"))
  })

  it("never forwards sessionId to the SDK even when the caller supplies one", async () => {
    const runner = createSdkRunner()
    await runner.run(
      "taskify",
      "prompt",
      "test-model",
      30_000,
      tmpDir,
      { sessionId: "ccce-legacy-session-id", resumeSession: false },
    )
    expect(queryCalls).toHaveLength(1)
    // Must be explicitly undefined (not the caller's value) — passing any
    // sessionId to the SDK in this process triggers the subprocess-exit crash.
    expect(queryCalls[0].sessionId).toBeUndefined()
  })

  it("never forwards resume to the SDK even when the caller asks to resume", async () => {
    const runner = createSdkRunner()
    await runner.run(
      "plan",
      "prompt",
      "test-model",
      30_000,
      tmpDir,
      { sessionId: "explore-session", resumeSession: true },
    )
    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0].resume).toBeUndefined()
  })

  it("repeated calls stay isolated — no session leakage between them", async () => {
    const runner = createSdkRunner()
    await runner.run("taskify", "p1", "m", 30_000, tmpDir, {
      sessionId: "shared-id",
      resumeSession: false,
    })
    await runner.run("plan", "p2", "m", 30_000, tmpDir, {
      sessionId: "shared-id",
      resumeSession: true,
    })
    expect(queryCalls).toHaveLength(2)
    for (const opts of queryCalls) {
      expect(opts.sessionId).toBeUndefined()
      expect(opts.resume).toBeUndefined()
    }
  })

  it("still forwards non-session SDK options (model, allowedTools, maxTurns) correctly", async () => {
    const runner = createSdkRunner()
    await runner.run("build", "p", "some-model", 30_000, tmpDir, {
      allowedTools: ["Bash", "Read"],
      maxTurns: 7,
      maxBudgetUsd: 1.5,
    })
    expect(queryCalls).toHaveLength(1)
    const opts = queryCalls[0]
    expect(opts.model).toBe("some-model")
    expect(opts.allowedTools).toEqual(["Bash", "Read"])
    expect(opts.maxTurns).toBe(7)
    expect(opts.maxBudgetUsd).toBe(1.5)
  })
})
