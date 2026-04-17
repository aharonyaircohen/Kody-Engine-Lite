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
})
