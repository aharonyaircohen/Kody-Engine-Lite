/**
 * B0 tests — KODY_MEMORY_TRACE instrumentation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-trace-"))
}

describe("trace instrumentation (B0)", () => {
  let projectDir: string
  const originalTrace = process.env.KODY_MEMORY_TRACE

  beforeEach(async () => {
    projectDir = tmpProject()
    const { resetTrace } = await import("../../src/memory/graph/trace.js")
    resetTrace()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    if (originalTrace === undefined) delete process.env.KODY_MEMORY_TRACE
    else process.env.KODY_MEMORY_TRACE = originalTrace
  })

  it("records no events when KODY_MEMORY_TRACE is unset", async () => {
    delete process.env.KODY_MEMORY_TRACE
    const { resetTrace, getTraceEvents } = await import("../../src/memory/graph/trace.js")
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    resetTrace()

    ensureGraphDir(projectDir)
    writeNodes(projectDir, {})

    expect(getTraceEvents().length).toBe(0)
  })

  it("records writeNodes and readNodes events when KODY_MEMORY_TRACE=1", async () => {
    process.env.KODY_MEMORY_TRACE = "1"
    const { resetTrace, getTraceSummary } = await import("../../src/memory/graph/trace.js")
    const { ensureGraphDir, readNodes, writeNodes } = await import("../../src/memory/graph/store.js")
    resetTrace()

    ensureGraphDir(projectDir)
    writeNodes(projectDir, {})
    readNodes(projectDir)
    readNodes(projectDir)

    const summary = getTraceSummary()
    expect(summary.writeNodes?.calls).toBe(1)
    expect(summary.readNodes?.calls).toBe(2)
    expect(summary.readNodes.totalMs).toBeGreaterThanOrEqual(0)
  })

  it("formatTraceSummary returns a readable table", async () => {
    process.env.KODY_MEMORY_TRACE = "1"
    const { resetTrace, formatTraceSummary } = await import("../../src/memory/graph/trace.js")
    const { ensureGraphDir, writeNodes, readNodes } = await import("../../src/memory/graph/store.js")
    resetTrace()

    ensureGraphDir(projectDir)
    writeNodes(projectDir, {})
    readNodes(projectDir)

    const out = formatTraceSummary()
    expect(out).toContain("writeNodes")
    expect(out).toContain("readNodes")
    expect(out).toMatch(/calls/)
  })

  it("traced() records an !error-suffixed event when fn throws and rethrows", async () => {
    process.env.KODY_MEMORY_TRACE = "1"
    const { resetTrace, traced, getTraceEvents } = await import("../../src/memory/graph/trace.js")
    resetTrace()

    expect(() =>
      traced("boom-op", () => { throw new Error("nope") }),
    ).toThrow("nope")

    const events = getTraceEvents()
    expect(events).toHaveLength(1)
    expect(events[0].op).toBe("boom-op!error")
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it("getTraceSummary aggregates calls, totalMs, and maxMs per op", async () => {
    process.env.KODY_MEMORY_TRACE = "1"
    const { resetTrace, traced, getTraceSummary } = await import("../../src/memory/graph/trace.js")
    resetTrace()

    // Three calls to opA, one to opB; opA has varied durations
    traced("opA", () => { for (let i = 0; i < 10000; i++) void i })
    traced("opA", () => { for (let i = 0; i < 100; i++) void i })
    traced("opA", () => { for (let i = 0; i < 100; i++) void i })
    traced("opB", () => {})

    const s = getTraceSummary()
    expect(s.opA.calls).toBe(3)
    expect(s.opB.calls).toBe(1)
    expect(s.opA.totalMs).toBeGreaterThanOrEqual(s.opA.maxMs)
    expect(s.opA.maxMs).toBeGreaterThanOrEqual(0)
  })

  it("traced() passes through the return value when enabled", async () => {
    process.env.KODY_MEMORY_TRACE = "1"
    const { resetTrace, traced } = await import("../../src/memory/graph/trace.js")
    resetTrace()

    const result = traced("opX", () => ({ answer: 42 }))
    expect(result).toEqual({ answer: 42 })
  })

  it("traced() skips instrumentation and returns value when disabled", async () => {
    delete process.env.KODY_MEMORY_TRACE
    const { resetTrace, traced, getTraceEvents } = await import("../../src/memory/graph/trace.js")
    resetTrace()

    const result = traced("opZ", () => "z")
    expect(result).toBe("z")
    expect(getTraceEvents()).toHaveLength(0)
  })

  it("formatTraceSummary prints a placeholder when no events have been recorded", async () => {
    delete process.env.KODY_MEMORY_TRACE
    const { resetTrace, formatTraceSummary } = await import("../../src/memory/graph/trace.js")
    resetTrace()
    expect(formatTraceSummary()).toBe("(no trace events)")
  })
})
