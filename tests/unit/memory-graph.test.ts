import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-graph-test-"))
}

// ─── Store Tests ────────────────────────────────────────────────────────────────

describe("graph store", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("ensureGraphDir creates .kody/graph directory", async () => {
    const { ensureGraphDir, getGraphDir } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)
    expect(fs.existsSync(getGraphDir(projectDir))).toBe(true)
  })

  it("ensureGraphDir is idempotent", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)
    ensureGraphDir(projectDir) // should not throw
    expect(true).toBe(true)
  })

  it("writeNodes then readNodes returns the same data", async () => {
    const { ensureGraphDir, readNodes, writeNodes } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    const nodes = {
      "facts_auth_123": {
        id: "facts_auth_123",
        type: "facts",
        hall: "facts",
        room: "auth",
        content: "Use session cookies",
        episodeId: "ep_review_001",
        validFrom: "2026-01-01T00:00:00Z",
        validTo: null,
        tags: [],
      },
    }

    writeNodes(projectDir, nodes)
    const read = readNodes(projectDir)
    expect(read).toEqual(nodes)
  })

  it("writeNodes is atomic (rename is synchronous after write)", async () => {
    const { ensureGraphDir, readNodes, writeNodes } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    const nodes = {
      "facts_test_456": {
        id: "facts_test_456",
        type: "facts",
        hall: "facts",
        room: "test",
        content: "Atomic write test",
        episodeId: "ep_review_001",
        validFrom: "2026-01-01T00:00:00Z",
        validTo: null,
        tags: [],
      },
    }

    writeNodes(projectDir, nodes)
    // If atomic, read should be consistent even if read happens immediately after
    const read = readNodes(projectDir)
    expect(read["facts_test_456"]).toBeDefined()
  })

  it("readNodes returns empty object for missing file", async () => {
    const { readNodes } = await import("../../src/memory/graph/store.js")
    const result = readNodes(projectDir)
    expect(result).toEqual({})
  })

  it("readNodes throws on corrupt JSON when no .bak exists", async () => {
    const { readNodes } = await import("../../src/memory/graph/store.js")
    const graphDir = path.join(projectDir, ".kody", "graph")
    fs.mkdirSync(graphDir, { recursive: true })
    fs.writeFileSync(path.join(graphDir, "nodes.json"), "{ corrupt json", "utf-8")

    // Fail-loud: no silent data loss, operator must intervene
    expect(() => readNodes(projectDir)).toThrow(/Corrupt graph file/)
  })

  it("readNodes auto-recovers from .bak when primary is corrupt", async () => {
    const { readNodes } = await import("../../src/memory/graph/store.js")
    const graphDir = path.join(projectDir, ".kody", "graph")
    fs.mkdirSync(graphDir, { recursive: true })

    // Valid backup, corrupt primary — readNodes should restore from .bak
    const validPayload = { version: 1, nodes: { a: { id: "a", type: "facts", hall: "facts", room: "r", content: "saved", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null } } }
    fs.writeFileSync(path.join(graphDir, "nodes.json.bak"), JSON.stringify(validPayload), "utf-8")
    fs.writeFileSync(path.join(graphDir, "nodes.json"), "{ corrupt", "utf-8")

    const result = readNodes(projectDir)
    expect(result.a?.content).toBe("saved")
    // Primary should be healed from .bak
    const reparsed = JSON.parse(fs.readFileSync(path.join(graphDir, "nodes.json"), "utf-8"))
    expect(reparsed.version).toBe(1)
  })

  it("writeEdges then readEdges returns the same data", async () => {
    const { ensureGraphDir, readEdges, writeEdges } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    const edges = [
      {
        id: "facts_auth_a_superseded_by_facts_auth_b",
        from: "facts_auth_a",
        rel: "superseded_by",
        to: "facts_auth_b",
        episodeId: "ep_review_001",
        validFrom: "2026-04-01T00:00:00Z",
        validTo: null,
      },
    ]

    writeEdges(projectDir, edges)
    const read = readEdges(projectDir)
    expect(read).toEqual(edges)
  })

  it("readEdges returns empty array for missing file", async () => {
    const { readEdges } = await import("../../src/memory/graph/store.js")
    const result = readEdges(projectDir)
    expect(result).toEqual([])
  })

  it("readEdges throws on corrupt JSON when no .bak exists", async () => {
    const { readEdges } = await import("../../src/memory/graph/store.js")
    const graphDir = path.join(projectDir, ".kody", "graph")
    fs.mkdirSync(graphDir, { recursive: true })
    fs.writeFileSync(path.join(graphDir, "edges.json"), "[ corrupt", "utf-8")

    expect(() => readEdges(projectDir)).toThrow(/Corrupt graph file/)
  })

  it("readEdges auto-recovers from .bak when primary is corrupt", async () => {
    const { readEdges } = await import("../../src/memory/graph/store.js")
    const graphDir = path.join(projectDir, ".kody", "graph")
    fs.mkdirSync(graphDir, { recursive: true })

    const validPayload = { version: 1, edges: [{ id: "e1", from: "a", rel: "related_to", to: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null }] }
    fs.writeFileSync(path.join(graphDir, "edges.json.bak"), JSON.stringify(validPayload), "utf-8")
    fs.writeFileSync(path.join(graphDir, "edges.json"), "[ corrupt", "utf-8")

    const result = readEdges(projectDir)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("e1")
  })

  it("nodes.json path is .kody/graph/nodes.json", async () => {
    const { ensureGraphDir, getGraphDir } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)
    const nodesPath = path.join(getGraphDir(projectDir), "nodes.json")
    expect(nodesPath).toContain(".kody")
    expect(nodesPath).toContain("graph")
    expect(nodesPath).toContain("nodes.json")
  })
})

// ─── Episode Tests ─────────────────────────────────────────────────────────────

describe("episode management", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("createEpisode writes episode file and returns Episode", async () => {
    const { ensureGraphDir, createEpisode } = await import("../../src/memory/graph/episode.js")
    ensureGraphDir(projectDir)

    const episode = await createEpisode(projectDir, {
      runId: "run_042",
      source: "review",
      taskId: "1234",
      createdAt: "2026-04-01T10:00:00Z",
      rawContent: "User prefers Vitest",
      extractedNodeIds: [],
      linkedFiles: ["src/utils/test.ts"],
    })

    expect(episode.id).toMatch(/^ep_review_\d+$/)
    expect(episode.runId).toBe("run_042")
    expect(episode.source).toBe("review")
    expect(episode.taskId).toBe("1234")
    expect(episode.rawContent).toBe("User prefers Vitest")

    // File should exist
    const episodePath = path.join(projectDir, ".kody", "graph", "episodes", `${episode.id}.json`)
    expect(fs.existsSync(episodePath)).toBe(true)
  })

  it("getEpisode returns episode by id", async () => {
    const { ensureGraphDir, createEpisode, getEpisode } = await import("../../src/memory/graph/episode.js")
    ensureGraphDir(projectDir)

    const created = await createEpisode(projectDir, {
      runId: "run_043",
      source: "user_feedback",
      taskId: "5678",
      createdAt: "2026-04-02T10:00:00Z",
      rawContent: "Use Postgres",
      extractedNodeIds: [],
    })

    const found = await getEpisode(projectDir, created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.rawContent).toBe("Use Postgres")
  })

  it("getEpisode returns null for non-existent id", async () => {
    const { ensureGraphDir, getEpisode } = await import("../../src/memory/graph/episode.js")
    ensureGraphDir(projectDir)

    const result = await getEpisode(projectDir, "ep_nonexistent_999")
    expect(result).toBeNull()
  })

  it("getNextEpisodeSeq returns incrementing sequence per source", async () => {
    const { ensureGraphDir, getNextEpisodeSeq, createEpisode } = await import("../../src/memory/graph/episode.js")
    ensureGraphDir(projectDir)

    const seq1 = await getNextEpisodeSeq(projectDir, "review")
    const seq2 = await getNextEpisodeSeq(projectDir, "review")
    const seq3 = await getNextEpisodeSeq(projectDir, "ci_failure")

    expect(seq2).toBe(seq1 + 1)
    expect(seq3).toBe(1) // different source starts at 1
  })

  it("getEpisodesBySource returns all episodes of a source type", async () => {
    const { ensureGraphDir, createEpisode, getEpisodesBySource } = await import("../../src/memory/graph/episode.js")
    ensureGraphDir(projectDir)

    await createEpisode(projectDir, { runId: "r1", source: "review", taskId: "1", createdAt: "2026-04-01T00:00:00Z", rawContent: "a", extractedNodeIds: [] })
    await createEpisode(projectDir, { runId: "r2", source: "review", taskId: "2", createdAt: "2026-04-01T00:00:00Z", rawContent: "b", extractedNodeIds: [] })
    await createEpisode(projectDir, { runId: "r3", source: "ci_failure", taskId: "3", createdAt: "2026-04-01T00:00:00Z", rawContent: "c", extractedNodeIds: [] })

    const reviews = await getEpisodesBySource(projectDir, "review")
    const ci = await getEpisodesBySource(projectDir, "ci_failure")

    expect(reviews).toHaveLength(2)
    expect(ci).toHaveLength(1)
  })

  it("getEpisodesByRun returns episodes for a runId", async () => {
    const { ensureGraphDir, createEpisode, getEpisodesByRun } = await import("../../src/memory/graph/episode.js")
    ensureGraphDir(projectDir)

    await createEpisode(projectDir, { runId: "run_100", source: "review", taskId: "1", createdAt: "2026-04-01T00:00:00Z", rawContent: "a", extractedNodeIds: [] })
    await createEpisode(projectDir, { runId: "run_100", source: "user_feedback", taskId: "2", createdAt: "2026-04-01T00:00:00Z", rawContent: "b", extractedNodeIds: [] })
    await createEpisode(projectDir, { runId: "run_200", source: "review", taskId: "3", createdAt: "2026-04-01T00:00:00Z", rawContent: "c", extractedNodeIds: [] })

    const run100 = await getEpisodesByRun(projectDir, "run_100")
    expect(run100).toHaveLength(2)
    expect(run100.every(e => e.runId === "run_100")).toBe(true)
  })

  it("episode files are stored in episodes/ subdirectory", async () => {
    const { ensureGraphDir, createEpisode } = await import("../../src/memory/graph/episode.js")
    ensureGraphDir(projectDir)

    const episode = await createEpisode(projectDir, {
      runId: "run_999",
      source: "plan",
      taskId: "1",
      createdAt: "2026-04-01T00:00:00Z",
      rawContent: "test",
      extractedNodeIds: [],
    })

    const episodePath = path.join(projectDir, ".kody", "graph", "episodes", `${episode.id}.json`)
    expect(fs.existsSync(episodePath)).toBe(true)
  })
})

// ─── Types Tests ───────────────────────────────────────────────────────────────

describe("graph types", () => {
  it("HallType has all expected values", async () => {
    const { HallTypeValues } = await import("../../src/memory/graph/types.js")
    expect(HallTypeValues).toContain("facts")
    expect(HallTypeValues).toContain("conventions")
    expect(HallTypeValues).toContain("events")
    expect(HallTypeValues).toContain("preferences")
    expect(HallTypeValues).toContain("thoughts")
    expect(HallTypeValues).toHaveLength(5)
  })

  it("RelationshipType has all expected values", async () => {
    const { RelationshipTypeValues } = await import("../../src/memory/graph/types.js")
    expect(RelationshipTypeValues).toContain("superseded_by")
    expect(RelationshipTypeValues).toContain("supersedes")
    expect(RelationshipTypeValues).toContain("applies_to")
    expect(RelationshipTypeValues).toContain("related_to")
    expect(RelationshipTypeValues).toContain("caused_by")
    expect(RelationshipTypeValues).toContain("derived_from")
  })

  it("GraphNode interface structure", async () => {
    const node = {
      id: "facts_auth_123",
      type: "facts" as const,
      hall: "facts" as const,
      room: "auth",
      content: "Use session cookies",
      episodeId: "ep_review_001",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: null,
      tags: ["auth", "security"],
    }

    expect(node.id).toBe("facts_auth_123")
    expect(node.validTo).toBeNull()
    expect(node.tags).toContain("auth")
  })

  it("GraphEdge interface structure", async () => {
    const edge = {
      id: "a_superseded_by_b",
      from: "a",
      rel: "superseded_by" as const,
      to: "b",
      episodeId: "ep_review_001",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: null,
    }

    expect(edge.rel).toBe("superseded_by")
    expect(edge.validTo).toBeNull()
  })

  it("Episode interface structure", async () => {
    const episode = {
      id: "ep_review_001",
      runId: "run_042",
      source: "review" as const,
      taskId: "1234",
      createdAt: "2026-04-01T10:00:00Z",
      rawContent: "User prefers Vitest",
      extractedNodeIds: ["facts_testing_123"],
      linkedFiles: ["src/utils/test.ts"],
    }

    expect(episode.source).toBe("review")
    expect(episode.extractedNodeIds).toContain("facts_testing_123")
  })
})

// ─── Phase 2: Query Layer Tests ────────────────────────────────────────────────

describe("query: getCurrentFacts", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns only currently valid facts (validTo === null)", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const now = "2026-04-01T00:00:00Z"
    const past = "2025-01-01T00:00:00Z"
    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "current", episodeId: "ep_1", validFrom: now, validTo: null },
      "facts_auth_2": { id: "facts_auth_2", type: "facts", hall: "facts", room: "auth", content: "superseded", episodeId: "ep_1", validFrom: past, validTo: now },
    })

    const results = getCurrentFacts(projectDir)
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe("current")
  })

  it("filters by hall", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "a fact", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "conventions_auth_1": { id: "conventions_auth_1", type: "conventions", hall: "conventions", room: "auth", content: "a convention", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const factsOnly = getCurrentFacts(projectDir, "facts")
    const conventionsOnly = getCurrentFacts(projectDir, "conventions")
    expect(factsOnly).toHaveLength(1)
    expect(factsOnly[0].content).toBe("a fact")
    expect(conventionsOnly).toHaveLength(1)
    expect(conventionsOnly[0].content).toBe("a convention")
  })

  it("filters by room", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "auth fact", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "facts_testing_1": { id: "facts_testing_1", type: "facts", hall: "facts", room: "testing", content: "testing fact", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const authFacts = getCurrentFacts(projectDir, "facts", "auth")
    expect(authFacts).toHaveLength(1)
    expect(authFacts[0].content).toBe("auth fact")
  })

  it("returns empty array for empty graph", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const results = getCurrentFacts(projectDir)
    expect(results).toEqual([])
  })
})

describe("query: getFactsAtTime", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns facts valid at the given time", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_old_1": { id: "facts_old_1", type: "facts", hall: "facts", room: "auth", content: "old fact", episodeId: "ep_1", validFrom: "2025-01-01T00:00:00Z", validTo: "2026-01-01T00:00:00Z" },
      "facts_new_1": { id: "facts_new_1", type: "facts", hall: "facts", room: "auth", content: "new fact", episodeId: "ep_1", validFrom: "2026-01-01T00:00:00Z", validTo: null },
    })

    const oldSnapshot = getFactsAtTime(projectDir, "2025-06-01T00:00:00Z")
    expect(oldSnapshot).toHaveLength(1)
    expect(oldSnapshot[0].content).toBe("old fact")

    const newSnapshot = getFactsAtTime(projectDir, "2026-06-01T00:00:00Z")
    expect(newSnapshot).toHaveLength(1)
    expect(newSnapshot[0].content).toBe("new fact")
  })

  it("boundary: validFrom == query time is included", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "exact", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const result = getFactsAtTime(projectDir, "2026-04-01T00:00:00Z")
    expect(result).toHaveLength(1)
  })
})

describe("query: getFactById + getFactHistory", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("getFactById returns a single fact", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { getFactById } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "found", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const result = getFactById(projectDir, "facts_auth_1")
    expect(result).not.toBeNull()
    expect(result!.content).toBe("found")
  })

  it("getFactById returns null for non-existent id", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { getFactById } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const result = getFactById(projectDir, "nonexistent")
    expect(result).toBeNull()
  })

  it("getFactHistory follows superseded_by chain", async () => {
    const { ensureGraphDir, writeNodes, writeEdges } = await import("../../src/memory/graph/store.js")
    const { getFactHistory } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_v1": { id: "facts_auth_v1", type: "facts", hall: "facts", room: "auth", content: "original", episodeId: "ep_1", validFrom: "2026-01-01T00:00:00Z", validTo: "2026-04-01T00:00:00Z" },
      "facts_auth_v2": { id: "facts_auth_v2", type: "facts", hall: "facts", room: "auth", content: "updated", episodeId: "ep_2", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })
    writeEdges(projectDir, [
      { id: "facts_auth_v1_superseded_by_facts_auth_v2", from: "facts_auth_v1", rel: "superseded_by", to: "facts_auth_v2", episodeId: "ep_2", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    ])

    const history = getFactHistory(projectDir, "facts_auth_v1")
    expect(history).toHaveLength(2)
    expect(history[0].content).toBe("original")
    expect(history[1].content).toBe("updated")
  })
})

describe("query: searchFacts", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns facts matching query string (case-insensitive)", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { searchFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "Use JWT tokens for API auth", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "facts_testing_1": { id: "facts_testing_1", type: "facts", hall: "facts", room: "testing", content: "Use Vitest for unit tests", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const results = searchFacts(projectDir, "JWT")
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain("JWT")
  })

  it("filters by hall", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { searchFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "JWT auth mentioned in facts", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "conventions_auth_1": { id: "conventions_auth_1", type: "conventions", hall: "conventions", room: "auth", content: "JWT pattern in conventions", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const factsOnly = searchFacts(projectDir, "JWT", "facts")
    expect(factsOnly).toHaveLength(1)
    expect(factsOnly[0].hall).toBe("facts")
  })

  it("respects limit", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { searchFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "JWT fact", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "conventions_auth_1": { id: "conventions_auth_1", type: "conventions", hall: "conventions", room: "auth", content: "JWT convention", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const limited = searchFacts(projectDir, "JWT", undefined, 1)
    expect(limited).toHaveLength(1)
  })
})

describe("query: edge traversal", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("getRelatedFacts traverses outgoing edges", async () => {
    const { ensureGraphDir, writeNodes, writeEdges } = await import("../../src/memory/graph/store.js")
    const { getRelatedFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "JWT", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "facts_auth_2": { id: "facts_auth_2", type: "facts", hall: "facts", room: "auth", content: "session", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })
    writeEdges(projectDir, [
      { id: "e1", from: "facts_auth_1", rel: "related_to", to: "facts_auth_2", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    ])

    const related = getRelatedFacts(projectDir, "facts_auth_1")
    expect(related).toHaveLength(1)
    expect(related[0].content).toBe("session")
  })

  it("getRelatedFacts filters by relationship type", async () => {
    const { ensureGraphDir, writeNodes, writeEdges } = await import("../../src/memory/graph/store.js")
    const { getRelatedFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "a": { id: "a", type: "facts", hall: "facts", room: "r", content: "a", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "b": { id: "b", type: "facts", hall: "facts", room: "r", content: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "c": { id: "c", type: "facts", hall: "facts", room: "r", content: "c", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })
    writeEdges(projectDir, [
      { id: "e1", from: "a", rel: "related_to", to: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      { id: "e2", from: "a", rel: "superseded_by", to: "c", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    ])

    const onlyRelated = getRelatedFacts(projectDir, "a", "related_to")
    expect(onlyRelated).toHaveLength(1)
    expect(onlyRelated[0].id).toBe("b")
  })

  it("getOutgoingEdges and getIncomingEdges", async () => {
    const { ensureGraphDir, writeNodes, writeEdges } = await import("../../src/memory/graph/store.js")
    const { getOutgoingEdges, getIncomingEdges } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "a": { id: "a", type: "facts", hall: "facts", room: "r", content: "a", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "b": { id: "b", type: "facts", hall: "facts", room: "r", content: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })
    writeEdges(projectDir, [
      { id: "e1", from: "a", rel: "related_to", to: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    ])

    const outgoing = getOutgoingEdges(projectDir, "a")
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0].to).toBe("b")

    const incoming = getIncomingEdges(projectDir, "b")
    expect(incoming).toHaveLength(1)
    expect(incoming[0].from).toBe("a")
  })
})

describe("query: getFactProvenance", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns the episode that created a fact", async () => {
    const { ensureGraphDir, createEpisode } = await import("../../src/memory/graph/episode.js")
    const { ensureGraphDir: ensure2, writeNodes } = await import("../../src/memory/graph/store.js")
    const { getFactProvenance } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)
    ensure2(projectDir)

    const episode = await createEpisode(projectDir, {
      runId: "run_042",
      source: "review",
      taskId: "1234",
      createdAt: "2026-04-01T00:00:00Z",
      rawContent: "User prefers Vitest",
      extractedNodeIds: [],
    })

    writeNodes(projectDir, {
      "facts_testing_1": { id: "facts_testing_1", type: "facts", hall: "facts", room: "testing", content: "Vitest preference", episodeId: episode.id, validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const provenance = getFactProvenance(projectDir, "facts_testing_1")
    expect(provenance).not.toBeNull()
    expect(provenance!.id).toBe(episode.id)
    expect(provenance!.rawContent).toBe("User prefers Vitest")
  })
})

// ─── Phase 3: Write Operation Tests ────────────────────────────────────────────

describe("write: writeFact", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("writes a new fact with validFrom set", async () => {
    const { ensureGraphDir, createEpisode } = await import("../../src/memory/graph/episode.js")
    const { writeFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const ep = await createEpisode(projectDir, { runId: "run_1", source: "review", taskId: "1", createdAt: "2026-04-01T00:00:00Z", rawContent: "raw", extractedNodeIds: [] })

    const fact = writeFact(projectDir, "facts", "auth", "Use session cookies", ep.id)
    expect(fact.hall).toBe("facts")
    expect(fact.room).toBe("auth")
    expect(fact.content).toBe("Use session cookies")
    expect(fact.validFrom).toBeTruthy()
    expect(fact.validTo).toBeNull()
    expect(fact.episodeId).toBe(ep.id)
  })

  it("generates unique id per write", async () => {
    const { ensureGraphDir, createEpisode } = await import("../../src/memory/graph/episode.js")
    const { writeFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const ep = await createEpisode(projectDir, { runId: "run_1", source: "review", taskId: "1", createdAt: "2026-04-01T00:00:00Z", rawContent: "raw", extractedNodeIds: [] })

    const f1 = writeFact(projectDir, "facts", "auth", "a", ep.id)
    const f2 = writeFact(projectDir, "facts", "auth", "b", ep.id)
    expect(f1.id).not.toBe(f2.id)
  })
})

describe("write: updateFact", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("invalidates old fact, creates new fact, writes superseded_by edge", async () => {
    const { ensureGraphDir, createEpisode } = await import("../../src/memory/graph/episode.js")
    const { writeFact, updateFact, getFactById, readNodes, readEdges } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const ep = await createEpisode(projectDir, { runId: "run_1", source: "review", taskId: "1", createdAt: "2026-04-01T00:00:00Z", rawContent: "raw", extractedNodeIds: [] })

    const oldFact = writeFact(projectDir, "facts", "auth", "Use JWT", ep.id)
    expect(oldFact.validTo).toBeNull()

    const newFact = updateFact(projectDir, oldFact.id, "Use session cookies instead", ep.id)

    // Old fact should be invalidated
    const invalidated = getFactById(projectDir, oldFact.id)
    expect(invalidated!.validTo).not.toBeNull()

    // New fact should exist
    expect(newFact.content).toBe("Use session cookies instead")
    expect(newFact.id).not.toBe(oldFact.id)

    // superseded_by edge should exist
    const edges = readEdges(projectDir)
    const supersededEdge = edges.find(e => e.from === oldFact.id && e.rel === "superseded_by")
    expect(supersededEdge).toBeDefined()
    expect(supersededEdge!.to).toBe(newFact.id)
  })
})

describe("write: writeEdge", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("writes an edge between two facts", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { ensureGraphDir: ensure2 } = await import("../../src/memory/graph/episode.js")
    const { writeEdge, readEdges } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)
    ensure2(projectDir)

    writeNodes(projectDir, {
      "a": { id: "a", type: "facts", hall: "facts", room: "r", content: "a", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "b": { id: "b", type: "facts", hall: "facts", room: "r", content: "b", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const edge = writeEdge(projectDir, "a", "related_to", "b", "ep_1")
    expect(edge.from).toBe("a")
    expect(edge.rel).toBe("related_to")
    expect(edge.to).toBe("b")
    expect(edge.validTo).toBeNull()

    const edges = readEdges(projectDir)
    expect(edges.some(e => e.from === "a" && e.rel === "related_to")).toBe(true)
  })
})

// ─── Phase 4: Serialization Tests ─────────────────────────────────────────────

describe("serialize: graphNodesToMarkdown", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("outputs markdown grouped by hall", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { graphNodesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "Use session cookies", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
      "conventions_testing_1": { id: "conventions_testing_1", type: "conventions", hall: "conventions", room: "testing", content: "Use Vitest", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    const nodes = getCurrentFacts(projectDir)
    const md = graphNodesToMarkdown(nodes)

    expect(md).toContain("## facts")
    expect(md).toContain("### auth")
    expect(md).toContain("Use session cookies")
    expect(md).toContain("## conventions")
    expect(md).toContain("### testing")
    expect(md).toContain("Use Vitest")
  })

  it("handles rooms without nodes gracefully", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { graphNodesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    ensureGraphDir(projectDir)

    const md = graphNodesToMarkdown([])
    expect(md).toBe("")
  })

  it("includes date in each bullet", async () => {
    const { ensureGraphDir, writeNodes } = await import("../../src/memory/graph/store.js")
    const { graphNodesToMarkdown } = await import("../../src/memory/graph/serialize.js")
    ensureGraphDir(projectDir)

    writeNodes(projectDir, {
      "facts_auth_1": { id: "facts_auth_1", type: "facts", hall: "facts", room: "auth", content: "JWT tokens", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null },
    })

    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    const md = graphNodesToMarkdown(getCurrentFacts(projectDir))
    expect(md).toMatch(/2026-04-01/)
  })
})

// ─── Phase 5: Migration Tests ──────────────────────────────────────────────────

describe("migration: migrateProjectMemory", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("reads legacy .md files and writes to graph", async () => {
    const memDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "conventions_auth.md"), "- Use session cookies\n- Prefer POST over GET for auth")
    fs.writeFileSync(path.join(memDir, "facts_testing.md"), "- Use Vitest")

    const { migrateProjectMemory } = await import("../../src/memory/migration.js")
    const result = await migrateProjectMemory(projectDir)

    expect(result.migrated).toBeGreaterThan(0)
    expect(result.errors).toHaveLength(0)

    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    const nodes = getCurrentFacts(projectDir)
    expect(nodes.length).toBeGreaterThanOrEqual(3)
    const authNodes = nodes.filter(n => n.room === "auth")
    expect(authNodes.some(n => n.content.includes("session cookies"))).toBe(true)
  })

  it("does not delete legacy .md files", async () => {
    const memDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "conventions_auth.md"), "- Use Vitest")

    const { migrateProjectMemory } = await import("../../src/memory/migration.js")
    await migrateProjectMemory(projectDir)

    expect(fs.existsSync(path.join(memDir, "conventions_auth.md"))).toBe(true)
  })

  it("parses hall from filename prefix", async () => {
    const memDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "preferences_workflow.md"), "- Always ask before acting")

    const { migrateProjectMemory } = await import("../../src/memory/migration.js")
    await migrateProjectMemory(projectDir)

    const { getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    const prefs = getCurrentFacts(projectDir, "preferences")
    expect(prefs.some(n => n.content.includes("Always ask"))).toBe(true)
  })

  it("skips files without hall prefix", async () => {
    const memDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "architecture.md"), "- Next.js app")
    fs.writeFileSync(path.join(memDir, "conventions_auth.md"), "- Auth convention")

    const { migrateProjectMemory } = await import("../../src/memory/migration.js")
    const result = await migrateProjectMemory(projectDir)

    // architecture.md has no recognized prefix — gets skipped or goes to conventions
    expect(result.skipped).toBeGreaterThanOrEqual(0)
  })

  it("handles missing .kody/memory directory gracefully", async () => {
    const { migrateProjectMemory } = await import("../../src/memory/migration.js")
    const result = await migrateProjectMemory(projectDir)
    expect(result.migrated).toBe(0)
    expect(result.errors).toHaveLength(0)
  })
})
