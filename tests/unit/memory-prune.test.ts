/**
 * W-C — pruneInvalidatedOlderThan
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-prune-"))
}

function backdateValidTo(projectDir: string, nodeId: string, daysAgo: number): void {
  const nodesPath = path.join(projectDir, ".kody/graph/nodes.json")
  const raw = JSON.parse(fs.readFileSync(nodesPath, "utf-8"))
  const payload = "nodes" in raw ? raw : { version: 1, nodes: raw }
  const node = payload.nodes[nodeId]
  node.validTo = new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString()
  fs.writeFileSync(nodesPath, JSON.stringify(payload, null, 2))
}

describe("pruneInvalidatedOlderThan", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("no-op when no facts are invalidated", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact } = await import("../../src/memory/graph/queries.js")
    const { pruneInvalidatedOlderThan } = await import("../../src/memory/graph/prune.js")
    ensureGraphDir(projectDir)
    writeFact(projectDir, "facts", "auth", "Active", "ep_1")

    const report = pruneInvalidatedOlderThan(projectDir, 90)
    expect(report.nodesArchived).toBe(0)
    expect(fs.existsSync(path.join(projectDir, ".kody/graph/archived.json"))).toBe(false)
  })

  it("moves invalidated beyond cutoff to archived.json", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, getCurrentFacts, getFactById } = await import("../../src/memory/graph/queries.js")
    const { pruneInvalidatedOlderThan } = await import("../../src/memory/graph/prune.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Stale", "ep_1")
    invalidateFact(projectDir, fact.id)
    backdateValidTo(projectDir, fact.id, 100)

    const report = pruneInvalidatedOlderThan(projectDir, 90)
    expect(report.nodesArchived).toBe(1)
    expect(fs.existsSync(path.join(projectDir, ".kody/graph/archived.json"))).toBe(true)

    // Gone from live nodes
    expect(getFactById(projectDir, fact.id)).toBeNull()
    expect(getCurrentFacts(projectDir)).toHaveLength(0)

    // Preserved in archive
    const archived = JSON.parse(fs.readFileSync(path.join(projectDir, ".kody/graph/archived.json"), "utf-8"))
    expect(archived.nodes[fact.id]).toBeDefined()
    expect(archived.version).toBe(1)
  })

  it("leaves invalidated-but-recent facts untouched", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, getFactById } = await import("../../src/memory/graph/queries.js")
    const { pruneInvalidatedOlderThan } = await import("../../src/memory/graph/prune.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Just retracted", "ep_1")
    invalidateFact(projectDir, fact.id)
    // Do NOT backdate — validTo is "now"

    const report = pruneInvalidatedOlderThan(projectDir, 90)
    expect(report.nodesArchived).toBe(0)
    expect(getFactById(projectDir, fact.id)).not.toBeNull()
  })

  it("cascade-archives edges where both endpoints are archived", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, writeEdge, invalidateFact, readEdges } = await import("../../src/memory/graph/queries.js")
    const { pruneInvalidatedOlderThan } = await import("../../src/memory/graph/prune.js")
    ensureGraphDir(projectDir)

    const a = writeFact(projectDir, "facts", "auth", "A", "ep_1")
    const b = writeFact(projectDir, "facts", "auth", "B", "ep_2")
    writeEdge(projectDir, a.id, "related_to", b.id, "ep_1")
    invalidateFact(projectDir, a.id)
    invalidateFact(projectDir, b.id)
    backdateValidTo(projectDir, a.id, 100)
    backdateValidTo(projectDir, b.id, 100)

    pruneInvalidatedOlderThan(projectDir, 90)

    const remainingEdges = readEdges(projectDir)
    expect(remainingEdges).toHaveLength(0)
    const archived = JSON.parse(fs.readFileSync(path.join(projectDir, ".kody/graph/archived.json"), "utf-8"))
    expect(archived.edges.length).toBeGreaterThan(0)
  })

  it("preserves edges where only one endpoint is archived", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, writeEdge, invalidateFact, readEdges } = await import("../../src/memory/graph/queries.js")
    const { pruneInvalidatedOlderThan } = await import("../../src/memory/graph/prune.js")
    ensureGraphDir(projectDir)

    const a = writeFact(projectDir, "facts", "auth", "A", "ep_1")
    const b = writeFact(projectDir, "facts", "auth", "B", "ep_2")
    writeEdge(projectDir, a.id, "related_to", b.id, "ep_1")
    invalidateFact(projectDir, a.id)
    backdateValidTo(projectDir, a.id, 100)
    // b stays live

    pruneInvalidatedOlderThan(projectDir, 90)

    const remaining = readEdges(projectDir)
    expect(remaining).toHaveLength(1)
  })

  it("dry-run reports without touching files", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, getFactById } = await import("../../src/memory/graph/queries.js")
    const { pruneInvalidatedOlderThan } = await import("../../src/memory/graph/prune.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Stale", "ep_1")
    invalidateFact(projectDir, fact.id)
    backdateValidTo(projectDir, fact.id, 100)

    const report = pruneInvalidatedOlderThan(projectDir, 90, { dryRun: true })
    expect(report.nodesArchived).toBe(1)
    // File NOT written
    expect(fs.existsSync(path.join(projectDir, ".kody/graph/archived.json"))).toBe(false)
    // Fact still live in the main nodes.json
    expect(getFactById(projectDir, fact.id)).not.toBeNull()
  })

  it("merges into an existing archived.json on second run", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact } = await import("../../src/memory/graph/queries.js")
    const { pruneInvalidatedOlderThan } = await import("../../src/memory/graph/prune.js")
    ensureGraphDir(projectDir)

    const a = writeFact(projectDir, "facts", "x", "A", "ep_1")
    invalidateFact(projectDir, a.id)
    backdateValidTo(projectDir, a.id, 100)
    pruneInvalidatedOlderThan(projectDir, 90)

    const b = writeFact(projectDir, "facts", "x", "B", "ep_2")
    invalidateFact(projectDir, b.id)
    backdateValidTo(projectDir, b.id, 100)
    pruneInvalidatedOlderThan(projectDir, 90)

    const archived = JSON.parse(fs.readFileSync(path.join(projectDir, ".kody/graph/archived.json"), "utf-8"))
    expect(archived.nodes[a.id]).toBeDefined()
    expect(archived.nodes[b.id]).toBeDefined()
  })
})
