/**
 * A4 tests — validateGraph invariant checker.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-validate-"))
}

describe("validateGraph", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns ok=true for an empty graph", async () => {
    const { validateGraph } = await import("../../src/memory/graph/validate.js")
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)
    const report = validateGraph(projectDir)
    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([])
  })

  it("returns ok=true for a well-formed graph", async () => {
    const { ensureGraphDir, writeNodes, writeEdges } = await import("../../src/memory/graph/store.js")
    const { validateGraph } = await import("../../src/memory/graph/validate.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      a: { id: "a", type: "facts", hall: "facts", room: "r", content: "a", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      b: { id: "b", type: "facts", hall: "facts", room: "r", content: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })
    writeEdges(projectDir, [
      { id: "e1", from: "a", rel: "related_to", to: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    ])

    const report = validateGraph(projectDir)
    expect(report.ok).toBe(true)
    expect(report.nodeCount).toBe(2)
    expect(report.edgeCount).toBe(1)
  })

  it("flags dangling edge.from", async () => {
    const { ensureGraphDir, writeNodes, writeEdges } = await import("../../src/memory/graph/store.js")
    const { validateGraph } = await import("../../src/memory/graph/validate.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      b: { id: "b", type: "facts", hall: "facts", room: "r", content: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })
    writeEdges(projectDir, [
      { id: "e1", from: "missing", rel: "related_to", to: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    ])

    const report = validateGraph(projectDir)
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.code === "edge.dangling_from")).toBe(true)
  })

  it("flags key / id mismatch", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { validateGraph } = await import("../../src/memory/graph/validate.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      // Intentional mismatch
      "stored-key": { id: "different-id", type: "facts", hall: "facts", room: "r", content: "x", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const report = validateGraph(projectDir)
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.code === "node.id_mismatch")).toBe(true)
  })

  it("flags validTo preceding validFrom", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { validateGraph } = await import("../../src/memory/graph/validate.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      bad: { id: "bad", type: "facts", hall: "facts", room: "r", content: "x", episodeId: "ep_1", validFrom: "2026-04-10T00:00:00Z", validTo: "2026-04-01T00:00:00Z" },
    })

    const report = validateGraph(projectDir)
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.code === "node.time_reversed")).toBe(true)
  })

  it("flags a superseded_by cycle", async () => {
    const { ensureGraphDir, writeNodes, writeEdges } = await import("../../src/memory/graph/store.js")
    const { validateGraph } = await import("../../src/memory/graph/validate.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      a: { id: "a", type: "facts", hall: "facts", room: "r", content: "a", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      b: { id: "b", type: "facts", hall: "facts", room: "r", content: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })
    writeEdges(projectDir, [
      { id: "e1", from: "a", rel: "superseded_by", to: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      { id: "e2", from: "b", rel: "superseded_by", to: "a", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    ])

    const report = validateGraph(projectDir)
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.code === "edge.supersede_cycle")).toBe(true)
  })
})
