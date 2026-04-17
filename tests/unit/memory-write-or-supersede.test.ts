/**
 * W-1 — writeFactOrSupersede tiered persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-supersede-"))
}

describe("writeFactOrSupersede", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("kind='new' when no similar content exists", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFactOrSupersede } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const outcome = writeFactOrSupersede(projectDir, "conventions", "auth", "Use session cookies", "ep_1")
    expect(outcome.kind).toBe("new")
    if (outcome.kind === "new") expect(outcome.next.content).toBe("Use session cookies")
  })

  it("kind='skipped' on exact content match (same hall, room, content)", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFactOrSupersede } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFactOrSupersede(projectDir, "conventions", "auth", "Use session cookies", "ep_1")
    const second = writeFactOrSupersede(projectDir, "conventions", "auth", "Use session cookies", "ep_2")
    expect(second.kind).toBe("skipped")
  })

  it("kind='superseded' on high-similarity content (≥0.85)", async () => {
    const { ensureGraphDir, readEdges } = await import("../../src/memory/graph/store.js")
    const { writeFactOrSupersede } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking enabled globally across monorepo",
      "ep_1",
    )
    const update = writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking disabled globally across monorepo",
      "ep_2",
    )
    expect(update.kind).toBe("superseded")
    if (update.kind === "superseded") {
      expect(update.old.validTo).not.toBeNull()
      expect(update.next.content).toContain("disabled")
    }
    // A superseded_by edge exists
    const edges = readEdges(projectDir)
    expect(edges.some((e) => e.rel === "superseded_by")).toBe(true)
  })

  it("kind='related' on medium-similarity content (0.6-0.85)", async () => {
    const { ensureGraphDir, readEdges } = await import("../../src/memory/graph/store.js")
    const { writeFactOrSupersede } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    // Two sentences sharing 4 significant tokens out of 5 each → Dice ~0.8
    writeFactOrSupersede(
      projectDir,
      "conventions",
      "auth",
      "Use session cookies for authentication and authorization",
      "ep_1",
    )
    const next = writeFactOrSupersede(
      projectDir,
      "conventions",
      "auth",
      "Use session tokens for authentication and authorization",
      "ep_2",
      undefined,
      undefined,
      // Tighten highThreshold so the 0.8 similarity falls in the related band
      { highThreshold: 0.9, relateThreshold: 0.6 },
    )
    expect(next.kind).toBe("related")
    if (next.kind === "related") {
      expect(next.neighbor.id).not.toBe(next.next.id)
      expect(next.edge.rel).toBe("related_to")
    }
    const edges = readEdges(projectDir)
    expect(edges.some((e) => e.rel === "related_to")).toBe(true)
  })

  it("carries confidence through supersede", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFactOrSupersede } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking enabled globally across monorepo",
      "ep_1",
      undefined,
      0.95,
    )
    const update = writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking disabled globally across monorepo",
      "ep_2",
      undefined,
      0.95,
    )
    expect(update.kind).toBe("superseded")
    if (update.kind === "superseded") {
      expect(update.next.confidence).toBe(0.95)
    }
  })

  it("carries tags through supersede", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFactOrSupersede } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking enabled globally across monorepo",
      "ep_1",
      ["stage:build", "kind:convention"],
      0.7,
    )
    const update = writeFactOrSupersede(
      projectDir,
      "conventions",
      "testing",
      "Use Vitest for unit testing framework with coverage tracking disabled globally across monorepo",
      "ep_2",
      ["stage:build", "kind:convention"],
      0.7,
    )
    expect(update.kind).toBe("superseded")
    if (update.kind === "superseded") {
      expect(update.next.tags).toContain("stage:build")
    }
  })

  it("findBestSimilarRecentNode returns similarity score", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, findBestSimilarRecentNode } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFact(projectDir, "facts", "auth", "Use JWT for API authentication tokens", "ep_1")
    const best = findBestSimilarRecentNode(
      projectDir,
      "facts",
      "Use JWT for API authentication tokens with short TTL",
    )
    expect(best).not.toBeNull()
    expect(best!.similarity).toBeGreaterThan(0.5)
  })
})
