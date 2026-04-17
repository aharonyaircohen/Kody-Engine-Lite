/**
 * W-A — confidence field with source-based defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-confidence-"))
}

describe("defaultConfidenceFor", () => {
  it("returns 1.0 for user_feedback", async () => {
    const { defaultConfidenceFor } = await import("../../src/memory/graph/confidence.js")
    expect(defaultConfidenceFor("user_feedback")).toBe(1.0)
  })

  it("returns lower values for weaker sources", async () => {
    const { defaultConfidenceFor } = await import("../../src/memory/graph/confidence.js")
    expect(defaultConfidenceFor("nudge")).toBeLessThan(defaultConfidenceFor("review"))
    expect(defaultConfidenceFor("stage_diary")).toBeLessThan(defaultConfidenceFor("migration"))
  })

  it("is defined for every EpisodeSource", async () => {
    const { defaultConfidenceFor, SOURCE_CONFIDENCE } = await import("../../src/memory/graph/confidence.js")
    const { EpisodeSourceValues } = await import("../../src/memory/graph/types.js")
    for (const src of EpisodeSourceValues) {
      expect(SOURCE_CONFIDENCE[src]).toBeGreaterThan(0)
      expect(defaultConfidenceFor(src)).toBeLessThanOrEqual(1)
    }
  })
})

describe("normalizeConfidence", () => {
  it("clamps to [0, 1]", async () => {
    const { normalizeConfidence } = await import("../../src/memory/graph/confidence.js")
    expect(normalizeConfidence(-0.5)).toBe(0)
    expect(normalizeConfidence(1.5)).toBe(1)
    expect(normalizeConfidence(0.7)).toBe(0.7)
  })

  it("returns undefined for non-finite / non-numeric", async () => {
    const { normalizeConfidence } = await import("../../src/memory/graph/confidence.js")
    expect(normalizeConfidence(NaN)).toBeUndefined()
    expect(normalizeConfidence(Infinity)).toBeUndefined()
    expect(normalizeConfidence("0.5")).toBeUndefined()
    expect(normalizeConfidence(null)).toBeUndefined()
  })
})

describe("writeFact persists confidence", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("stores confidence when provided", async () => {
    const { ensureGraphDir, readNodes } = await import("../../src/memory/graph/store.js")
    const { writeFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Use JWT", "ep_1", undefined, 0.85)
    expect(fact.confidence).toBe(0.85)

    const nodes = readNodes(projectDir)
    expect(nodes[fact.id].confidence).toBe(0.85)
  })

  it("omits confidence field when not provided", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Use session cookies", "ep_2")
    expect(fact.confidence).toBeUndefined()
  })

  it("writeFactOnce persists confidence", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFactOnce } = await import("../../src/memory/graph/write-utils.js")
    ensureGraphDir(projectDir)

    const fact = writeFactOnce(projectDir, "conventions", "testing", "Use Vitest", "ep_1", undefined, 0.95)
    expect(fact?.confidence).toBe(0.95)
  })
})

describe("serialize includes confidence when asked", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("emits [c=X] when includeConfidence is true", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact } = await import("../../src/memory/graph/queries.js")
    const { graphNodesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFact(projectDir, "facts", "auth", "Use JWT", "ep_1", undefined, 0.9)

    const md = graphNodesToMarkdown(getCurrentFacts(projectDir), { includeConfidence: true })
    expect(md).toMatch(/c=0\.9/)
  })

  it("emits id= when includeIds is true", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    const { graphNodesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Use JWT", "ep_1")
    const md = graphNodesToMarkdown(getCurrentFacts(projectDir), { includeIds: true })
    expect(md).toContain(`id=${fact.id}`)
  })

  it("omits confidence and id by default for backward compat", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    const { graphNodesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    ensureGraphDir(projectDir)

    writeFact(projectDir, "facts", "auth", "Use JWT", "ep_1", undefined, 0.9)
    const md = graphNodesToMarkdown(getCurrentFacts(projectDir))
    expect(md).not.toContain("c=")
    expect(md).not.toContain("id=")
  })
})
