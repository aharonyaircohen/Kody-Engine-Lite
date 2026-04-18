/**
 * Temporal queries — read as-of a past timestamp.
 *
 * Covers:
 *   - getFactsAtTime (boundary conditions)
 *   - searchFactsByScopeAsOf (scope + time filter, related_to expansion)
 *   - getOutgoingEdgesAtTime (temporal edge filter)
 *   - CLI `--as-of` flag parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-temporal-"))
}

function seedNodes(
  projectDir: string,
  nodes: Array<{
    id: string
    hall: string
    room: string
    content: string
    validFrom: string
    validTo: string | null
  }>,
): void {
  const graphDir = path.join(projectDir, ".kody", "graph")
  fs.mkdirSync(graphDir, { recursive: true })
  const payload = {
    version: 1,
    nodes: Object.fromEntries(
      nodes.map((n) => [
        n.id,
        {
          id: n.id,
          type: n.hall,
          hall: n.hall,
          room: n.room,
          content: n.content,
          episodeId: "ep_test_001",
          validFrom: n.validFrom,
          validTo: n.validTo,
        },
      ]),
    ),
  }
  fs.writeFileSync(path.join(graphDir, "nodes.json"), JSON.stringify(payload), "utf-8")
}

function seedEdges(
  projectDir: string,
  edges: Array<{
    id: string
    from: string
    rel: string
    to: string
    validFrom: string
    validTo: string | null
  }>,
): void {
  const graphDir = path.join(projectDir, ".kody", "graph")
  fs.mkdirSync(graphDir, { recursive: true })
  const payload = {
    version: 1,
    edges: edges.map((e) => ({
      id: e.id,
      from: e.from,
      rel: e.rel,
      to: e.to,
      episodeId: "ep_test_001",
      validFrom: e.validFrom,
      validTo: e.validTo,
    })),
  }
  fs.writeFileSync(path.join(graphDir, "edges.json"), JSON.stringify(payload), "utf-8")
}

// ─── getFactsAtTime ──────────────────────────────────────────────────────────

describe("getFactsAtTime", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns empty array for empty graph", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z")
    expect(result).toEqual([])
  })

  it("includes fact whose validFrom <= ts and validTo is null", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z")
    expect(result.map((n) => n.id)).toEqual(["n1"])
  })

  it("includes fact that was invalidated AFTER the query timestamp", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-04-01T00:00:00.000Z" },
    ])
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z")
    expect(result.map((n) => n.id)).toEqual(["n1"])
  })

  it("excludes fact that was invalidated BEFORE the query timestamp", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" },
    ])
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z")
    expect(result).toEqual([])
  })

  it("excludes fact whose validFrom is AFTER the query timestamp", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-05-01T00:00:00.000Z", validTo: null },
    ])
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z")
    expect(result).toEqual([])
  })

  it("boundary: ts equal to validFrom is inclusive", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-03-01T00:00:00.000Z", validTo: null },
    ])
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z")
    expect(result.map((n) => n.id)).toEqual(["n1"])
  })

  it("boundary: ts equal to validTo is EXCLUSIVE (fact already invalidated)", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-03-01T00:00:00.000Z" },
    ])
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z")
    expect(result).toEqual([])
  })

  it("filters by hall when provided", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
      { id: "n2", hall: "conventions", room: "auth", content: "Use PascalCase", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    const result = getFactsAtTime(projectDir, "2026-03-01T00:00:00.000Z", "conventions")
    expect(result.map((n) => n.id)).toEqual(["n2"])
  })

  it("returns a supersede chain correctly: only the version live at ts", async () => {
    const { getFactsAtTime } = await import("../../src/memory/graph/queries.js")
    // v1 live Jan-Mar, v2 live Mar-onwards
    seedNodes(projectDir, [
      { id: "v1", hall: "facts", room: "auth", content: "uses v1 API", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-03-01T00:00:00.000Z" },
      { id: "v2", hall: "facts", room: "auth", content: "uses v2 API", validFrom: "2026-03-01T00:00:00.000Z", validTo: null },
    ])

    const inJan = getFactsAtTime(projectDir, "2026-02-01T00:00:00.000Z").map((n) => n.id)
    expect(inJan).toEqual(["v1"])

    const inApr = getFactsAtTime(projectDir, "2026-04-01T00:00:00.000Z").map((n) => n.id)
    expect(inApr).toEqual(["v2"])
  })
})

// ─── getOutgoingEdgesAtTime ─────────────────────────────────────────────────

describe("getOutgoingEdgesAtTime", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns edges live at the given timestamp", async () => {
    const { getOutgoingEdgesAtTime } = await import("../../src/memory/graph/queries.js")
    seedEdges(projectDir, [
      { id: "e1", from: "a", rel: "related_to", to: "b", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
      { id: "e2", from: "a", rel: "related_to", to: "c", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" },
    ])
    const result = getOutgoingEdgesAtTime(projectDir, "a", "2026-03-01T00:00:00.000Z", "related_to")
    expect(result.map((e) => e.id)).toEqual(["e1"])
  })

  it("includes edges invalidated AFTER the timestamp", async () => {
    const { getOutgoingEdgesAtTime } = await import("../../src/memory/graph/queries.js")
    seedEdges(projectDir, [
      { id: "e1", from: "a", rel: "related_to", to: "b", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-04-01T00:00:00.000Z" },
    ])
    const result = getOutgoingEdgesAtTime(projectDir, "a", "2026-03-01T00:00:00.000Z")
    expect(result.map((e) => e.id)).toEqual(["e1"])
  })

  it("excludes edges not yet live at the timestamp", async () => {
    const { getOutgoingEdgesAtTime } = await import("../../src/memory/graph/queries.js")
    seedEdges(projectDir, [
      { id: "e1", from: "a", rel: "related_to", to: "b", validFrom: "2026-05-01T00:00:00.000Z", validTo: null },
    ])
    const result = getOutgoingEdgesAtTime(projectDir, "a", "2026-03-01T00:00:00.000Z")
    expect(result).toEqual([])
  })

  it("filters by rel when provided", async () => {
    const { getOutgoingEdgesAtTime } = await import("../../src/memory/graph/queries.js")
    seedEdges(projectDir, [
      { id: "e1", from: "a", rel: "related_to", to: "b", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
      { id: "e2", from: "a", rel: "caused_by", to: "c", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    const result = getOutgoingEdgesAtTime(projectDir, "a", "2026-03-01T00:00:00.000Z", "caused_by")
    expect(result.map((e) => e.id)).toEqual(["e2"])
  })
})

// ─── searchFactsByScopeAsOf ─────────────────────────────────────────────────

describe("searchFactsByScopeAsOf", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns facts in scope that were live at ts", async () => {
    const { searchFactsByScopeAsOf } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "uses JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    const result = searchFactsByScopeAsOf(
      projectDir,
      ["src/auth/login.ts"],
      "2026-03-01T00:00:00.000Z",
    )
    expect(result.map((n) => n.id)).toEqual(["n1"])
  })

  it("excludes facts invalidated before ts", async () => {
    const { searchFactsByScopeAsOf } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "old JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" },
    ])
    const result = searchFactsByScopeAsOf(
      projectDir,
      ["src/auth/login.ts"],
      "2026-03-01T00:00:00.000Z",
    )
    expect(result).toEqual([])
  })

  it("returns the historical version when a fact has been superseded", async () => {
    const { searchFactsByScopeAsOf } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "v1", hall: "facts", room: "auth", content: "v1 content", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-03-01T00:00:00.000Z" },
      { id: "v2", hall: "facts", room: "auth", content: "v2 content", validFrom: "2026-03-01T00:00:00.000Z", validTo: null },
    ])
    const result = searchFactsByScopeAsOf(
      projectDir,
      ["src/auth/login.ts"],
      "2026-02-01T00:00:00.000Z",
    )
    expect(result.map((n) => n.id)).toEqual(["v1"])
  })

  it("returns empty for empty scope", async () => {
    const { searchFactsByScopeAsOf } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "n1", hall: "facts", room: "auth", content: "JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    const result = searchFactsByScopeAsOf(projectDir, [], "2026-03-01T00:00:00.000Z")
    expect(result).toEqual([])
  })

  it("expands via related_to edges that were live at ts", async () => {
    const { searchFactsByScopeAsOf } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "auth_main", hall: "facts", room: "auth", content: "uses JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
      { id: "session_fact", hall: "facts", room: "session", content: "30-min TTL", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    seedEdges(projectDir, [
      { id: "e1", from: "auth_main", rel: "related_to", to: "session_fact", validFrom: "2026-01-15T00:00:00.000Z", validTo: null },
    ])
    const result = searchFactsByScopeAsOf(
      projectDir,
      ["src/auth/login.ts"],
      "2026-03-01T00:00:00.000Z",
    )
    const ids = result.map((n) => n.id).sort()
    expect(ids).toEqual(["auth_main", "session_fact"])
  })

  it("does NOT expand via related_to edges that were invalidated before ts", async () => {
    const { searchFactsByScopeAsOf } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "auth_main", hall: "facts", room: "auth", content: "uses JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
      { id: "session_fact", hall: "facts", room: "session", content: "30-min TTL", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    seedEdges(projectDir, [
      { id: "e1", from: "auth_main", rel: "related_to", to: "session_fact", validFrom: "2026-01-15T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" },
    ])
    const result = searchFactsByScopeAsOf(
      projectDir,
      ["src/auth/login.ts"],
      "2026-03-01T00:00:00.000Z",
    )
    expect(result.map((n) => n.id)).toEqual(["auth_main"])
  })

  it("skips expansion when expandRelated is false", async () => {
    const { searchFactsByScopeAsOf } = await import("../../src/memory/graph/queries.js")
    seedNodes(projectDir, [
      { id: "auth_main", hall: "facts", room: "auth", content: "uses JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
      { id: "session_fact", hall: "facts", room: "session", content: "30-min TTL", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])
    seedEdges(projectDir, [
      { id: "e1", from: "auth_main", rel: "related_to", to: "session_fact", validFrom: "2026-01-15T00:00:00.000Z", validTo: null },
    ])
    const result = searchFactsByScopeAsOf(
      projectDir,
      ["src/auth/login.ts"],
      "2026-03-01T00:00:00.000Z",
      5,
      { expandRelated: false },
    )
    expect(result.map((n) => n.id)).toEqual(["auth_main"])
  })
})

// ─── CLI --as-of flag ───────────────────────────────────────────────────────

describe("kody graph --as-of CLI flag", () => {
  let projectDir: string
  let logs: string[]
  let errs: string[]
  let origLog: typeof console.log
  let origErr: typeof console.error

  beforeEach(() => {
    projectDir = tmpProject()
    logs = []
    errs = []
    origLog = console.log
    origErr = console.error
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")) }
  })

  afterEach(() => {
    console.log = origLog
    console.error = origErr
    fs.rmSync(projectDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("`query --as-of` lists facts live at the given timestamp", async () => {
    seedNodes(projectDir, [
      { id: "v1", hall: "facts", room: "auth", content: "old content", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-03-01T00:00:00.000Z" },
      { id: "v2", hall: "facts", room: "auth", content: "new content", validFrom: "2026-03-01T00:00:00.000Z", validTo: null },
    ])

    const { runGraphCommand } = await import("../../src/bin/commands/graph.js")
    await runGraphCommand(["query", projectDir, "--as-of=2026-02-01"])
    const out = logs.join("\n")
    expect(out).toContain("old content")
    expect(out).not.toContain("new content")
  })

  it("`query --as-of=<future>` lists current live facts", async () => {
    seedNodes(projectDir, [
      { id: "v1", hall: "facts", room: "auth", content: "old content", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-03-01T00:00:00.000Z" },
      { id: "v2", hall: "facts", room: "auth", content: "new content", validFrom: "2026-03-01T00:00:00.000Z", validTo: null },
    ])

    const { runGraphCommand } = await import("../../src/bin/commands/graph.js")
    await runGraphCommand(["query", projectDir, "--as-of=2026-04-01"])
    const out = logs.join("\n")
    expect(out).toContain("new content")
    expect(out).not.toContain("old content")
  })

  it("`query --as-of` combined with a search term filters temporally and by substring", async () => {
    seedNodes(projectDir, [
      { id: "v1", hall: "facts", room: "auth", content: "uses JWT tokens", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-03-01T00:00:00.000Z" },
      { id: "v2", hall: "facts", room: "auth", content: "uses session cookies", validFrom: "2026-03-01T00:00:00.000Z", validTo: null },
    ])

    const { runGraphCommand } = await import("../../src/bin/commands/graph.js")
    await runGraphCommand(["query", projectDir, "JWT", "--as-of=2026-02-01"])
    const out = logs.join("\n")
    expect(out).toContain("JWT")
    expect(out).toContain("1 facts matching")
  })

  it("`status --as-of` reports counts at the given timestamp", async () => {
    seedNodes(projectDir, [
      { id: "v1", hall: "facts", room: "auth", content: "old", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-03-01T00:00:00.000Z" },
      { id: "v2", hall: "conventions", room: "auth", content: "conv", validFrom: "2026-03-01T00:00:00.000Z", validTo: null },
    ])

    const { runGraphCommand } = await import("../../src/bin/commands/graph.js")
    await runGraphCommand(["status", projectDir, "--as-of=2026-02-01"])
    const out = logs.join("\n")
    expect(out).toContain("as of")
    expect(out).toContain("facts: 1")
    expect(out).not.toContain("conventions: 1")
  })

  it("`--as-of=<invalid>` prints error and exits non-zero", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)

    const { runGraphCommand } = await import("../../src/bin/commands/graph.js")
    await expect(
      runGraphCommand(["query", projectDir, "--as-of=not-a-date"]),
    ).rejects.toThrow(/process\.exit:1/)

    expect(errs.join("\n")).toMatch(/Invalid --as-of/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it("`--as-of` without a value prints error and exits non-zero", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)

    const { runGraphCommand } = await import("../../src/bin/commands/graph.js")
    await expect(
      runGraphCommand(["query", projectDir, "--as-of"]),
    ).rejects.toThrow(/process\.exit:1/)

    expect(errs.join("\n")).toMatch(/--as-of requires/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it("`--as-of=YYYY-MM-DD` (date-only) is accepted", async () => {
    seedNodes(projectDir, [
      { id: "v1", hall: "facts", room: "auth", content: "uses JWT", validFrom: "2026-01-01T00:00:00.000Z", validTo: null },
    ])

    const { runGraphCommand } = await import("../../src/bin/commands/graph.js")
    await runGraphCommand(["status", projectDir, "--as-of=2026-03-01"])
    const out = logs.join("\n")
    expect(out).toContain("facts: 1")
  })
})
