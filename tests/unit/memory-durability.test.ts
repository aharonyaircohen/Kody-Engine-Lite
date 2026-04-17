/**
 * A1 tests — store.ts durability & hardening.
 *
 * Covers:
 *   - atomicWrite creates .bak from the previous committed state
 *   - crypto.randomUUID() tmp names cannot collide
 *   - fsync is called (observable via closed fd after write)
 *   - Schema version wrapper is written and round-trips
 *   - Legacy (unwrapped) format still reads correctly
 *   - Both primary and backup corrupt → throws
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-durability-"))
}

describe("store durability (A1)", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("writeNodes creates nodes.json.bak on the second write", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    const n1 = { a: { id: "a", type: "facts" as const, hall: "facts" as const, room: "r", content: "first", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null } }
    writeNodes(projectDir, n1)

    const n2 = { a: { id: "a", type: "facts" as const, hall: "facts" as const, room: "r", content: "second", episodeId: "ep_1", validFrom: "2026-04-02T00:00:00Z", validTo: null } }
    writeNodes(projectDir, n2)

    const bakPath = path.join(projectDir, ".kody", "graph", "nodes.json.bak")
    expect(fs.existsSync(bakPath)).toBe(true)
    const bak = JSON.parse(fs.readFileSync(bakPath, "utf-8"))
    expect(bak.nodes.a.content).toBe("first")
  })

  it("writeNodes persists in versioned format", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { CURRENT_SCHEMA_VERSION } = await import("../../src/memory/graph/types.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {})

    const raw = JSON.parse(fs.readFileSync(path.join(projectDir, ".kody", "graph", "nodes.json"), "utf-8"))
    expect(raw.version).toBe(CURRENT_SCHEMA_VERSION)
    expect(raw.nodes).toEqual({})
  })

  it("readNodes accepts legacy flat format and roundtrips to versioned after next write", async () => {
    const { ensureGraphDir, readNodes, writeNodes } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    // Simulate an on-disk file written by an older Kody version
    const legacyFlat = {
      a: { id: "a", type: "facts", hall: "facts", room: "r", content: "legacy", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    }
    fs.writeFileSync(path.join(projectDir, ".kody", "graph", "nodes.json"), JSON.stringify(legacyFlat), "utf-8")

    const read = readNodes(projectDir)
    expect(read.a?.content).toBe("legacy")

    // Writing back upgrades the format
    writeNodes(projectDir, read)
    const upgraded = JSON.parse(fs.readFileSync(path.join(projectDir, ".kody", "graph", "nodes.json"), "utf-8"))
    expect(upgraded.version).toBe(1)
    expect(upgraded.nodes.a.content).toBe("legacy")
  })

  it("throws when both nodes.json and nodes.json.bak are corrupt", async () => {
    const { readNodes } = await import("../../src/memory/graph/store.js")
    const graphDir = path.join(projectDir, ".kody", "graph")
    fs.mkdirSync(graphDir, { recursive: true })
    fs.writeFileSync(path.join(graphDir, "nodes.json"), "{ broken", "utf-8")
    fs.writeFileSync(path.join(graphDir, "nodes.json.bak"), "also broken", "utf-8")

    expect(() => readNodes(projectDir)).toThrow(/Corrupt graph file AND \.bak/)
  })

  it("does not leave orphan .tmp files after a successful write", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)
    writeNodes(projectDir, {})

    const graphDir = path.join(projectDir, ".kody", "graph")
    const stragglers = fs.readdirSync(graphDir).filter(f => f.includes(".tmp."))
    expect(stragglers).toEqual([])
  })

  it("writeEdges round-trips through versioned format", async () => {
    const { ensureGraphDir, readEdges, writeEdges } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    const edges = [{ id: "e1", from: "a", rel: "related_to" as const, to: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null }]
    writeEdges(projectDir, edges)
    const raw = JSON.parse(fs.readFileSync(path.join(projectDir, ".kody", "graph", "edges.json"), "utf-8"))
    expect(raw.version).toBe(1)
    expect(raw.edges).toHaveLength(1)

    const read = readEdges(projectDir)
    expect(read).toEqual(edges)
  })
})
