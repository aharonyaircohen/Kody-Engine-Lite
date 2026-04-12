import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import { indexEpisode, searchSessions, removeFromIndex, rebuildIndex } from "../../src/memory/search.js"
import { ensureGraphDir } from "../../src/memory/graph/index.js"
import type { Episode } from "../../src/memory/graph/types.js"

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "ep_test_001",
    runId: "run_001",
    source: "plan",
    taskId: "task_001",
    createdAt: new Date().toISOString(),
    rawContent: "The auth module uses JWT tokens stored in httpOnly cookies for session management",
    extractedNodeIds: [],
    linkedFiles: [],
    ...overrides,
  }
}

describe("Integration: FTS search", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-fts-int-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: { defaultRunner: "sdk", modelMap: { cheap: "test", mid: "test", strong: "test" } },
      }),
    )
    setConfigDir(tmpDir)
    ensureGraphDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("searchSessions returns empty array when no episodes indexed", () => {
    const results = searchSessions(tmpDir, "JWT authentication")
    expect(results).toEqual([])
  })

  it("indexEpisode + searchSessions finds episode by keyword", () => {
    const ep = makeEpisode({
      id: "ep_auth_001",
      rawContent: "Use bcrypt for password hashing — never store plain-text passwords",
    })
    indexEpisode(tmpDir, ep)

    const results = searchSessions(tmpDir, "bcrypt password hashing")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.episodeId).toBe("ep_auth_001")
    expect(results[0]!.source).toBe("plan")
  })

  it("searchSessions returns results ranked by BM25 score", () => {
    const ep1 = makeEpisode({
      id: "ep_generic",
      rawContent: "Authentication is important for security in any application",
    })
    const ep2 = makeEpisode({
      id: "ep_specific",
      rawContent: "Authentication uses JWT tokens in httpOnly cookies with refresh token rotation",
    })

    indexEpisode(tmpDir, ep1)
    indexEpisode(tmpDir, ep2)

    const results = searchSessions(tmpDir, "JWT authentication tokens")

    // The more specific episode should score higher
    const jwtEp = results.find(r => r.episodeId === "ep_specific")
    const helperEp = results.find(r => r.episodeId === "ep_generic")
    expect(jwtEp).toBeDefined()
    expect(helperEp).toBeDefined()
    expect(jwtEp!.score).toBeGreaterThan(helperEp!.score)
  })

  it("searchSessions respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      indexEpisode(tmpDir, makeEpisode({
        id: `ep_multi_${i}`,
        rawContent: `Task number ${i} involves authentication and JWT tokens`,
      }))
    }

    const results = searchSessions(tmpDir, "authentication JWT", 2)
    expect(results.length).toBe(2)
  })

  it("searchSessions returns snippets with highlighted terms", () => {
    indexEpisode(tmpDir, makeEpisode({
      id: "ep_snippet",
      rawContent: "The JWT token should be stored in an httpOnly cookie to prevent XSS attacks",
    }))

    const results = searchSessions(tmpDir, "JWT httpOnly cookie XSS")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.snippet).toContain("**JWT**")
    expect(results[0]!.snippet).toContain("**httpOnly**")
  })

  it("searchSessions ignores stopwords", () => {
    indexEpisode(tmpDir, makeEpisode({
      id: "ep_stopword",
      rawContent: "The payment gateway integrates with Stripe using API keys",
    }))

    // "the" is a stopword, should not affect results
    const resultsWith = searchSessions(tmpDir, "the payment gateway Stripe")
    const resultsWithout = searchSessions(tmpDir, "payment gateway Stripe")

    expect(resultsWith.length).toBeGreaterThan(0)
    expect(resultsWithout.length).toBeGreaterThan(0)
  })

  it("removeFromIndex removes a document from search results", () => {
    const ep = makeEpisode({
      id: "ep_remove",
      rawContent: "Rate limiting is set to 100 requests per minute",
    })
    indexEpisode(tmpDir, ep)

    const before = searchSessions(tmpDir, "rate limiting")
    expect(before.length).toBeGreaterThan(0)

    removeFromIndex(tmpDir, "ep_remove")

    const after = searchSessions(tmpDir, "rate limiting")
    expect(after.find(r => r.episodeId === "ep_remove")).toBeUndefined()
  })

  it("rebuildIndex reindexes all episodes in the index", () => {
    // Write the episode file to disk (rebuildIndex reads from episode files, not index)
    const episodePath = path.join(tmpDir, ".kody", "graph", "episodes", "ep_rebuild.json")
    fs.mkdirSync(path.dirname(episodePath), { recursive: true })
    const ep = makeEpisode({
      id: "ep_rebuild",
      rawContent: "Use Zod for runtime validation of API inputs",
    })
    fs.writeFileSync(episodePath, JSON.stringify(ep))

    indexEpisode(tmpDir, ep)

    // Manually corrupt the index (simulate partial write)
    const indexPath = path.join(tmpDir, ".kody", "graph", "sessions-index.json")
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"))
    delete index.documents["ep_rebuild"]
    fs.writeFileSync(indexPath, JSON.stringify(index))

    const before = searchSessions(tmpDir, "Zod validation")
    expect(before.length).toBe(0)

    rebuildIndex(tmpDir)

    const after = searchSessions(tmpDir, "Zod validation")
    expect(after.length).toBeGreaterThan(0)
    expect(after[0]!.episodeId).toBe("ep_rebuild")
  })

  it("indexEpisode stores taskId and createdAt in search results", () => {
    const createdAt = new Date().toISOString()
    indexEpisode(tmpDir, makeEpisode({
      id: "ep_meta",
      taskId: "task_graph_memory",
      source: "nudge",
      createdAt,
      rawContent: "Conventions: use immutable patterns for state updates",
    }))

    const results = searchSessions(tmpDir, "immutable patterns state")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.taskId).toBe("task_graph_memory")
    expect(results[0]!.source).toBe("nudge")
    expect(results[0]!.createdAt).toBe(createdAt)
  })

  it("searchSessions returns empty for query with no matching terms", () => {
    indexEpisode(tmpDir, makeEpisode({
      id: "ep_irrelevant",
      rawContent: "React components use functional patterns with hooks",
    }))

    const results = searchSessions(tmpDir, "database migration SQL")
    expect(results).toEqual([])
  })

  it("indexEpisode handles episodes with empty rawContent", () => {
    indexEpisode(tmpDir, makeEpisode({
      id: "ep_empty",
      rawContent: "",
    }))

    // Should not throw, empty doc should not match any query
    const results = searchSessions(tmpDir, "anything")
    expect(Array.isArray(results)).toBe(true)
  })

  it("multiple episodes with same term score independently", () => {
    for (let i = 0; i < 3; i++) {
      indexEpisode(tmpDir, makeEpisode({
        id: `ep_dup_${i}`,
        rawContent: "Always use type-safe TypeScript patterns for API responses",
      }))
    }

    const results = searchSessions(tmpDir, "type-safe TypeScript API")
    expect(results.length).toBe(3)
    // All should have the same score since identical content
    const scores = results.map(r => r.score)
    expect(new Set(scores).size).toBe(1)
  })
})
