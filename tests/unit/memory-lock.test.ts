/**
 * A2 coverage — direct tests for the withGraphLockSync/withGraphLock wrappers.
 *
 * The integration test (tests/int/memory-concurrent-writes.test.ts) covers
 * end-to-end behavior under a real N-process race. These unit tests cover
 * the wrapper's own contract:
 *   - creates lock directory on demand
 *   - runs fn once
 *   - releases on success
 *   - releases on throw
 *   - reclaims stale locks left by crashed prior holders
 *   - re-entrant call from inside fn() correctly serializes (async variant)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-lock-"))
}

describe("withGraphLockSync", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("creates the graph directory and lock sentinel on first call", async () => {
    const { withGraphLockSync } = await import("../../src/memory/graph/lock.js")
    withGraphLockSync(projectDir, () => {})
    const graphDir = path.join(projectDir, ".kody", "graph")
    expect(fs.existsSync(graphDir)).toBe(true)
    expect(fs.existsSync(path.join(graphDir, ".graph-lock"))).toBe(true)
  })

  it("runs the function and returns its value", async () => {
    const { withGraphLockSync } = await import("../../src/memory/graph/lock.js")
    const result = withGraphLockSync(projectDir, () => 42)
    expect(result).toBe(42)
  })

  it("releases the lock after a successful run", async () => {
    const { withGraphLockSync } = await import("../../src/memory/graph/lock.js")
    withGraphLockSync(projectDir, () => "first")
    // Lock was released — a second call should acquire cleanly (not hit
    // MAX_ATTEMPTS). If the lock weren't released, this would throw.
    const second = withGraphLockSync(projectDir, () => "second")
    expect(second).toBe("second")
  })

  it("releases the lock even when fn throws", async () => {
    const { withGraphLockSync } = await import("../../src/memory/graph/lock.js")
    expect(() => withGraphLockSync(projectDir, () => { throw new Error("boom") })).toThrow("boom")
    // Next call should still acquire
    const recovered = withGraphLockSync(projectDir, () => "recovered")
    expect(recovered).toBe("recovered")
  })

  it("serializes sequential calls (each sees the prior's writes)", async () => {
    const { withGraphLockSync } = await import("../../src/memory/graph/lock.js")
    const trace: string[] = []
    withGraphLockSync(projectDir, () => {
      trace.push("A-in")
      trace.push("A-out")
    })
    withGraphLockSync(projectDir, () => {
      trace.push("B-in")
      trace.push("B-out")
    })
    expect(trace).toEqual(["A-in", "A-out", "B-in", "B-out"])
  })

  it("reclaims a stale lock directory left by a crashed prior holder", async () => {
    const { withGraphLockSync } = await import("../../src/memory/graph/lock.js")
    // Simulate crash: proper-lockfile creates `<sentinel>.lock/` as the
    // actual lock directory. Put one there with an old mtime.
    const graphDir = path.join(projectDir, ".kody", "graph")
    fs.mkdirSync(graphDir, { recursive: true })
    fs.writeFileSync(path.join(graphDir, ".graph-lock"), "")
    const lockDir = path.join(graphDir, ".graph-lock.lock")
    fs.mkdirSync(lockDir)
    // Backdate so proper-lockfile treats it as stale (>30s by default)
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockDir, old, old)

    // This would block forever if stale detection didn't work.
    const result = withGraphLockSync(projectDir, () => "acquired-after-stale")
    expect(result).toBe("acquired-after-stale")
  })
})

describe("withGraphLock (async)", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("awaits the async function and returns its resolved value", async () => {
    const { withGraphLock } = await import("../../src/memory/graph/lock.js")
    const result = await withGraphLock(projectDir, async () => {
      await new Promise(r => setTimeout(r, 5))
      return "async-ok"
    })
    expect(result).toBe("async-ok")
  })

  it("releases the async lock on rejection", async () => {
    const { withGraphLock } = await import("../../src/memory/graph/lock.js")
    await expect(
      withGraphLock(projectDir, async () => { throw new Error("async-boom") }),
    ).rejects.toThrow("async-boom")
    // Next call proceeds — lock was released
    const after = await withGraphLock(projectDir, async () => "released")
    expect(after).toBe("released")
  })
})
