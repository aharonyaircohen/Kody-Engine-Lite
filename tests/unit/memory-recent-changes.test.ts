/**
 * W-5 — getRecentlyChangedFacts + recentChangesToMarkdown
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-recent-"))
}

describe("getRecentlyChangedFacts", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns empty on empty graph", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { getRecentlyChangedFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)
    expect(getRecentlyChangedFacts(projectDir)).toEqual([])
  })

  it("returns retractions (invalidated facts without a superseding edge)", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, getRecentlyChangedFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const a = writeFact(projectDir, "facts", "auth", "Old rule", "ep_1")
    invalidateFact(projectDir, a.id)

    const changes = getRecentlyChangedFacts(projectDir, 14)
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe("retracted")
    expect(changes[0].previous.id).toBe(a.id)
    expect(changes[0].current).toBeNull()
  })

  it("returns supersedes (with superseded_by edge linking to current)", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFactOrSupersede, getRecentlyChangedFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking enabled globally across monorepo",
      "ep_1",
    )
    writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking disabled globally across monorepo",
      "ep_2",
    )

    const changes = getRecentlyChangedFacts(projectDir, 14)
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe("superseded")
    expect(changes[0].current).not.toBeNull()
    expect(changes[0].current!.content).toContain("disabled")
  })

  it("respects the sinceDays cutoff", async () => {
    const { ensureGraphDir, readNodes, writeNodes } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, getRecentlyChangedFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "old", "ancient fact", "ep_1")
    invalidateFact(projectDir, fact.id)

    // Backdate validTo to 40 days ago
    const nodes = readNodes(projectDir)
    const aged = { ...nodes[fact.id], validTo: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString() }
    writeNodes(projectDir, { ...nodes, [fact.id]: aged })

    const recent = getRecentlyChangedFacts(projectDir, 14)
    expect(recent).toHaveLength(0)

    const wide = getRecentlyChangedFacts(projectDir, 90)
    expect(wide).toHaveLength(1)
  })
})

describe("recentChangesToMarkdown", () => {
  it("returns empty string for empty list", async () => {
    const { recentChangesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    expect(recentChangesToMarkdown([])).toBe("")
  })

  it("renders retraction rows", async () => {
    const { recentChangesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    const md = recentChangesToMarkdown([
      {
        kind: "retracted",
        current: null,
        changedAt: "2026-04-10T00:00:00Z",
        previous: {
          id: "x",
          type: "facts",
          hall: "facts",
          room: "auth",
          content: "Use X",
          episodeId: "ep_1",
          validFrom: "2026-03-01T00:00:00Z",
          validTo: "2026-04-10T00:00:00Z",
        },
      },
    ])
    expect(md).toContain("## Recent memory changes")
    expect(md).toContain("retracted 2026-04-10")
    expect(md).toContain("Use X")
  })

  it("renders supersede rows with before/after", async () => {
    const { recentChangesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    const md = recentChangesToMarkdown([
      {
        kind: "superseded",
        changedAt: "2026-04-10T00:00:00Z",
        previous: {
          id: "x",
          type: "facts",
          hall: "facts",
          room: "auth",
          content: "Old content",
          episodeId: "ep_1",
          validFrom: "2026-03-01T00:00:00Z",
          validTo: "2026-04-10T00:00:00Z",
        },
        current: {
          id: "y",
          type: "facts",
          hall: "facts",
          room: "auth",
          content: "New content",
          episodeId: "ep_2",
          validFrom: "2026-04-10T00:00:00Z",
          validTo: null,
        },
      },
    ])
    expect(md).toContain("was:")
    expect(md).toContain("Old content")
    expect(md).toContain("now:")
    expect(md).toContain("New content")
  })
})
