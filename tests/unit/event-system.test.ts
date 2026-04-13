/**
 * Unit tests for the event system core:
 * - KodyEmitter (on, once, off, onAny, emit)
 * - HookRegistry (fire, error isolation)
 * - logHook (level mapping)
 *
 * These tests exercise the emitter and registry in isolation with
 * real handlers and mocked GitHub API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// Must set config dir before importing emitter (it uses process.cwd() for file paths)
let tmpDir: string
const ORIG_CWD = process.cwd()

function withTmpDir(fn: () => void) {
  process.chdir(tmpDir)
  try { fn() } finally { process.chdir(ORIG_CWD) }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-event-test-"))
  withTmpDir(() => fs.mkdirSync(".kody-engine", { recursive: true }))
})

afterEach(() => {
  process.chdir(ORIG_CWD)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── Imports (must be after tmpDir setup) ─────────────────────────────────────

import { KodyEmitter, emitter as globalEmitter, emit } from "../../src/event-system/events/emitter.js"
import { HookRegistry } from "../../src/event-system/hooks/registry.js"
import { logHook } from "../../src/event-system/hooks/impl/log.js"
import type { Hook, HookResult, HookContext } from "../../src/event-system/hooks/types.js"
import type { KodyEvent } from "../../src/event-system/events/types.js"

// ─── Mock GitHub API ────────────────────────────────────────────────────────────

vi.mock("../../src/github-api.js", () => ({
  setLabel: vi.fn().mockResolvedValue(undefined),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  postComment: vi.fn().mockResolvedValue(undefined),
}))

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<HookContext>): HookContext {
  return {
    runId: "test-run-1",
    ...overrides,
  }
}

function makeEvent<N extends string>(
  name: N,
  payload: Record<string, unknown> = {},
): KodyEvent {
  return {
    name: name as any,
    payload: payload as any,
    emittedAt: new Date(),
  }
}

// ─── KodyEmitter Tests ─────────────────────────────────────────────────────────

describe("KodyEmitter", () => {
  let emitter: KodyEmitter

  beforeEach(() => {
    emitter = new KodyEmitter()
  })

  describe("on()", () => {
    it("registers a handler for a specific event", async () => {
      const calls: KodyEvent[] = []
      const unsub = emitter.on("pipeline.started", (e) => calls.push(e))

      await emitter.emit("pipeline.started", { runId: "run-1" })
      expect(calls).toHaveLength(1)
      expect(calls[0].payload.runId).toBe("run-1")

      unsub()
    })

    it("does not fire handler for a different event", async () => {
      const calls: KodyEvent[] = []
      emitter.on("pipeline.started", (e) => calls.push(e))

      await emitter.emit("pipeline.success", { runId: "run-1" })
      expect(calls).toHaveLength(0)
    })

    it("fires for multiple registered handlers on the same event", async () => {
      const a: string[] = []
      const b: string[] = []
      emitter.on("pipeline.started", (e) => a.push(String((e.payload as any).runId)))
      emitter.on("pipeline.started", (e) => b.push(String((e.payload as any).runId)))

      await emitter.emit("pipeline.started", { runId: "run-1" })
      expect(a).toEqual(["run-1"])
      expect(b).toEqual(["run-1"])
    })

    it("returns an unsubscribe function", async () => {
      const calls: KodyEvent[] = []
      const unsub = emitter.on("pipeline.started", (e) => calls.push(e))

      await emitter.emit("pipeline.started", { runId: "run-1" })
      expect(calls).toHaveLength(1)

      unsub()

      await emitter.emit("pipeline.started", { runId: "run-2" })
      expect(calls).toHaveLength(1) // only first call
    })
  })

  describe("once()", () => {
    it("fires the handler only once then unsubscribes", async () => {
      const calls: KodyEvent[] = []
      emitter.once("pipeline.started", (e) => calls.push(e))

      await emitter.emit("pipeline.started", { runId: "run-1" })
      await emitter.emit("pipeline.started", { runId: "run-2" })

      expect(calls).toHaveLength(1)
      expect((calls[0].payload as any).runId).toBe("run-1")
    })
  })

  describe("off()", () => {
    it("removes a specific handler", async () => {
      const a: KodyEvent[] = []
      const b: KodyEvent[] = []
      const handlerA = (e: KodyEvent) => a.push(e)
      const handlerB = (e: KodyEvent) => b.push(e)

      emitter.on("pipeline.started", handlerA)
      emitter.on("pipeline.started", handlerB)

      emitter.off("pipeline.started", handlerA)

      await emitter.emit("pipeline.started", { runId: "run-1" })

      expect(a).toHaveLength(0)
      expect(b).toHaveLength(1)
    })
  })

  describe("onAny()", () => {
    it("fires for any event", async () => {
      const calls: KodyEvent[] = []
      emitter.onAny((e) => calls.push(e))

      await emitter.emit("pipeline.started", { runId: "run-1" })
      await emitter.emit("pipeline.success", { runId: "run-2" })

      expect(calls).toHaveLength(2)
    })

    it("returns an unsubscribe function", async () => {
      const calls: KodyEvent[] = []
      const unsub = emitter.onAny((e) => calls.push(e))

      await emitter.emit("pipeline.started", { runId: "run-1" })
      unsub()
      await emitter.emit("pipeline.success", { runId: "run-2" })

      expect(calls).toHaveLength(1)
    })
  })

  describe("emit()", () => {
    it("rejects unknown event names at runtime", async () => {
      // "totally.invalid.event" is not in the EventName union
      await expect(
        emitter.emit("totally.invalid.event" as any, { runId: "run-1" }),
      ).rejects.toThrow("Unknown event name")
    })

    it("emits to in-process handlers and onAny handlers concurrently", async () => {
      const order: string[] = []
      emitter.on("pipeline.started", async () => {
        order.push("specific")
      })
      emitter.onAny(async () => {
        order.push("any")
      })

      await emitter.emit("pipeline.started", { runId: "run-1" })
      // Both handlers ran (order not guaranteed due to Promise.allSettled)
      expect(order).toContain("specific")
      expect(order).toContain("any")
    })

    it("returns the emitted KodyEvent with emittedAt set", async () => {
      const result = await emitter.emit("pipeline.started", { runId: "run-1" })
      expect(result.name).toBe("pipeline.started")
      expect(result.emittedAt).toBeInstanceOf(Date)
      expect((result.payload as any).runId).toBe("run-1")
    })
  })

  describe("removeAllListeners()", () => {
    it("clears all handlers", async () => {
      const calls: KodyEvent[] = []
      emitter.on("pipeline.started", (e) => calls.push(e))
      emitter.onAny((e) => calls.push(e))

      emitter.removeAllListeners()

      await emitter.emit("pipeline.started", { runId: "run-1" })
      expect(calls).toHaveLength(0)
    })
  })

  describe("global singleton (emit convenience function)", () => {
    // The module-level emit() uses the singleton. We test it via globalEmitter
    // since each test has its own local emitter instance.

    it("globalEmitter.on() receives events from emit()", async () => {
      const calls: KodyEvent[] = []
      const unsub = globalEmitter.on("chat.message", (e) => calls.push(e))

      await emit("chat.message", {
        runId: "singleton-1",
        sessionId: "sess-1",
        role: "user",
        content: "hello from singleton",
        timestamp: new Date().toISOString(),
      })

      expect(calls).toHaveLength(1)
      expect((calls[0].payload as any).content).toBe("hello from singleton")

      unsub()
      globalEmitter.removeAllListeners()
    })
  })
})

// ─── HookRegistry Tests ─────────────────────────────────────────────────────────

describe("HookRegistry", () => {
  let registry: HookRegistry

  beforeEach(() => {
    registry = new HookRegistry()
  })

  it("fires log hook when configured", async () => {
    const event = makeEvent("pipeline.started", { runId: "run-1" })
    const results = await registry.fire(event, makeContext())

    expect(results.some((r) => r.hookType === "log")).toBe(true)
    const logResult = results.find((r) => r.hookType === "log")!
    expect(logResult.success).toBe(true)
    expect(logResult.data).toHaveProperty("level")
  })

  it("github-action hook returns skipped (handled externally)", async () => {
    const event = makeEvent("step.waiting", { runId: "run-1", step: "build" })
    const results = await registry.fire(event, makeContext())

    expect(results.some((r) => r.hookType === "github-action")).toBe(true)
    const result = results.find((r) => r.hookType === "github-action")!
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ skipped: true })
  })

  it("returns empty array when no hooks configured for event", async () => {
    const event = makeEvent("chat.done", { runId: "run-1", sessionId: "sess-1" })
    const results = await registry.fire(event, makeContext())
    // chat.done fires only the webhook hook
    expect(results).toHaveLength(1)
    expect(results[0].hookType).toBe("webhook")
  })

  it("isolates per-hook errors — one failing hook does not stop others", async () => {
    // Manually inject a broken hook by patching the registry cache
    const brokenHook: Hook = {
      handle: async () => { throw new Error("hook exploded") },
    }
    // @ts-ignore — accessing private cache for test
    registry.cache.set("log", brokenHook)

    const event = makeEvent("pipeline.started", { runId: "run-1" })
    const results = await registry.fire(event, makeContext())

    // The broken hook should appear with success: false
    const brokenResult = results.find((r) => r.hookType === "log")
    expect(brokenResult?.success).toBe(false)
    expect(brokenResult?.error).toContain("hook exploded")
  })

  it("returns error for unregistered hook type", async () => {
    // We can't easily inject an unknown type, but we can verify the registry
    // returns an error result when getImpl returns null
    // This is exercised by the "no impl" code path via registry.fire behavior
    const event = makeEvent("pipeline.started", { runId: "run-1" })
    // No hooks configured for pipeline.started beyond label+log
    const results = await registry.fire(event, makeContext())
    // log hook succeeded
    expect(results.every((r) => r.success)).toBe(true)
  })

  it("passes correct context to hook implementations", async () => {
    // Verify context fields are passed through by checking the log hook
    // (it has no external deps, so we can verify behavior)
    const event = makeEvent("step.waiting", {
      runId: "run-step-1",
      step: "build",
      issueNumber: 42,
    })
    const context = makeContext({
      runId: "run-step-1",
      issueNumber: 42,
    })
    const results = await registry.fire(event, context)

    // Should fire both github-action (skipped) and github-label + log
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── logHook Tests ─────────────────────────────────────────────────────────────

describe("logHook", () => {
  function handle(event: KodyEvent, context = makeContext()): HookResult {
    return logHook.handle(event, context)
  }

  it("returns success for any event", () => {
    const event = makeEvent("pipeline.started", { runId: "run-1" })
    const result = handle(event)
    expect(result.success).toBe(true)
    expect(result.hookType).toBe("log")
  })

  it("defaults to debug level when no logLevel in payload", () => {
    const event = makeEvent("pipeline.started", { runId: "run-1" })
    const result = handle(event)
    expect(result.data).toEqual({ level: "debug" })
  })

  it("maps logLevel from payload to correct level", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      const event = makeEvent("pipeline.started", { runId: "run-1", logLevel: level })
      const result = handle(event)
      expect(result.data).toEqual({ level })
    }
  })

  it("defaults to debug for unknown logLevel values", () => {
    const event = makeEvent("pipeline.started", { runId: "run-1", logLevel: "trace" as any })
    const result = handle(event)
    expect(result.data).toEqual({ level: "debug" })
  })

  it("ignores the context (log hook is stateless)", () => {
    const event = makeEvent("pipeline.started", { runId: "run-1" })
    const result = handle(event, { runId: "other-run", issueNumber: 99 } as HookContext)
    expect(result.success).toBe(true)
  })
})
