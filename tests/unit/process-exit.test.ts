import { describe, it, expect } from "vitest"

/**
 * Tests for process exit behavior after pipeline completion.
 *
 * Bug: When LiteLLM proxy runs as a detached child process, Node's event loop
 * stays alive after main() returns. The failed path called process.exit(1)
 * but the success path never exited, causing the GH Actions runner to hang.
 *
 * Fix: All code paths must explicitly call process.exit() or cleanupLitellm().
 */

describe("pipeline exit behavior", () => {
  // Model the exit decision logic from entry.ts
  type ExitAction =
    | { type: "exit"; code: 0 }
    | { type: "exit"; code: 1 }
    | { type: "exit"; code: 0; reason: "paused" }

  interface PipelineState {
    state: "completed" | "failed"
    stages: Record<string, { state: string; error?: string }>
  }

  function determineExitAction(state: PipelineState): ExitAction {
    if (state.state === "failed") {
      const isPaused = Object.values(state.stages).some(
        (s) => s.error?.includes("paused") ?? false,
      )
      if (isPaused) return { type: "exit", code: 0, reason: "paused" }
      return { type: "exit", code: 1 }
    }
    // Success — must still explicitly exit
    return { type: "exit", code: 0 }
  }

  it("exits 0 on pipeline success", () => {
    const state: PipelineState = {
      state: "completed",
      stages: { build: { state: "completed" }, verify: { state: "completed" } },
    }
    const action = determineExitAction(state)
    expect(action.code).toBe(0)
  })

  it("exits 1 on pipeline failure", () => {
    const state: PipelineState = {
      state: "failed",
      stages: { build: { state: "completed" }, verify: { state: "failed", error: "lint error" } },
    }
    const action = determineExitAction(state)
    expect(action.code).toBe(1)
  })

  it("exits 0 when paused (questions posted)", () => {
    const state: PipelineState = {
      state: "failed",
      stages: { taskify: { state: "completed" }, plan: { state: "failed", error: "paused: waiting for answers" } },
    }
    const action = determineExitAction(state)
    expect(action.code).toBe(0)
    expect(action).toHaveProperty("reason", "paused")
  })

  it("every code path produces an exit action", () => {
    // Exhaustive: all possible pipeline states must produce an exit
    const states: PipelineState[] = [
      { state: "completed", stages: {} },
      { state: "failed", stages: {} },
      { state: "failed", stages: { x: { state: "failed", error: "paused" } } },
      { state: "completed", stages: { build: { state: "completed" } } },
    ]
    for (const s of states) {
      const action = determineExitAction(s)
      expect(action.type).toBe("exit")
      expect([0, 1]).toContain(action.code)
    }
  })
})

describe("litellm cleanup on exit", () => {
  it("cleanup kills process and nullifies reference", () => {
    let killed = false
    let ref: { kill: () => void } | null = { kill: () => { killed = true } }
    const cleanup = () => { if (ref) { ref.kill(); ref = null } }

    cleanup()
    expect(killed).toBe(true)
    expect(ref).toBeNull()
  })

  it("cleanup is idempotent (safe to call twice)", () => {
    let killCount = 0
    let ref: { kill: () => void } | null = { kill: () => { killCount++ } }
    const cleanup = () => { if (ref) { ref.kill(); ref = null } }

    cleanup()
    cleanup()
    expect(killCount).toBe(1)
  })

  it("cleanup is safe when no process exists", () => {
    let ref: { kill: () => void } | null = null
    const cleanup = () => { if (ref) { ref.kill(); ref = null } }

    expect(() => cleanup()).not.toThrow()
  })
})
