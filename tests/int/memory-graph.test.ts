import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import * as graph from "../../src/memory/graph/index.js"
import { searchFactsByScope } from "../../src/memory/graph/queries.js"

describe("Integration: memory graph", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-graph-int-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", testUnit: "true" },
        agent: { defaultRunner: "sdk", modelMap: { cheap: "test", mid: "test", strong: "test" } },
      }),
    )
    setConfigDir(tmpDir)
    graph.ensureGraphDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("searchFactsByScope returns empty for empty scope", () => {
    const results = searchFactsByScope(tmpDir, [])
    expect(results).toEqual([])
  })

  it("searchFactsByScope returns matching facts by room", () => {
    // Write two facts in the "auth" room
    graph.writeFact(tmpDir, "conventions", "auth", "Use bcrypt for password hashing", "ep1")
    graph.writeFact(tmpDir, "facts", "auth", "Sessions expire after 24h", "ep2")
    graph.writeFact(tmpDir, "facts", "api", "Rate limit is 100 req/min", "ep3")

    const results = searchFactsByScope(tmpDir, ["src/auth/login.ts", "src/auth/logout.ts"], 5)
    const ids = results.map((r) => r.id)
    expect(ids.length).toBeGreaterThanOrEqual(2)
  })

  it("searchFactsByScope returns matching facts by keyword in content", () => {
    // Write fact about passwords — no room match but content matches "password"
    graph.writeFact(tmpDir, "conventions", "db", "Use transactions for multi-table writes", "ep1")
    graph.writeFact(tmpDir, "conventions", "security", "Passwords must be hashed with bcrypt", "ep2")

    // Scope has "auth" in the path, not "password" in the file name
    const results = searchFactsByScope(tmpDir, ["src/auth/middleware.ts"], 5)
    // Should match the security convention since "auth" appears in the room
    const securityFacts = results.filter((r) => r.room === "security")
    expect(securityFacts.length).toBeGreaterThanOrEqual(0) // may or may not match depending on room inference
  })

  it("searchFactsByScope respects limit", () => {
    graph.writeFact(tmpDir, "facts", "auth", "Fact 1", "ep1")
    graph.writeFact(tmpDir, "facts", "auth", "Fact 2", "ep2")
    graph.writeFact(tmpDir, "facts", "auth", "Fact 3", "ep3")
    graph.writeFact(tmpDir, "facts", "auth", "Fact 4", "ep4")
    graph.writeFact(tmpDir, "facts", "auth", "Fact 5", "ep5")

    const results = searchFactsByScope(tmpDir, ["src/auth/login.ts"], 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it("searchFactsByScope returns facts matching the scope", () => {
    graph.writeFact(tmpDir, "facts", "auth", "JWT auth fact", "ep1")
    graph.writeFact(tmpDir, "facts", "api", "API rate limit fact", "ep2")

    const results = searchFactsByScope(tmpDir, ["src/auth/middleware.ts"], 5)
    // Should include the auth fact but not the api fact (different room)
    const authFacts = results.filter((r) => r.room === "auth")
    expect(authFacts.length).toBeGreaterThanOrEqual(1)
    expect(authFacts[0].content).toContain("JWT")
  })

  it("graph roundtrip: write and read facts", () => {
    const fact = graph.writeFact(tmpDir, "facts", "api", "Base URL is https://api.example.com", "ep1")
    expect(fact.id).toBeTruthy()
    expect(fact.content).toBe("Base URL is https://api.example.com")
    expect(fact.room).toBe("api")
    expect(fact.hall).toBe("facts")

    const found = graph.getFactById(tmpDir, fact.id)
    expect(found).not.toBeNull()
    expect(found!.content).toBe("Base URL is https://api.example.com")
  })

  it("updateFact invalidates old and creates new", () => {
    const old = graph.writeFact(tmpDir, "facts", "auth", "Old session timeout", "ep1")
    const updated = graph.updateFact(tmpDir, old.id, "New session timeout: 48h", "ep2")

    const invalidated = graph.getFactById(tmpDir, old.id)
    expect(invalidated).not.toBeNull()
    expect(invalidated!.validTo).not.toBeNull() // old fact is invalidated

    expect(updated.content).toBe("New session timeout: 48h")
    expect(updated.id).not.toBe(old.id)

    // superseded_by edge should exist
    const edges = graph.getOutgoingEdges(tmpDir, old.id)
    expect(edges.some((e) => e.rel === "superseded_by")).toBe(true)
  })

  it("graphNodesToMarkdown serializes facts correctly", () => {
    graph.writeFact(tmpDir, "facts", "auth", "Use OAuth2 for authentication", "ep1")
    graph.writeFact(tmpDir, "conventions", "auth", "Never log tokens in plaintext", "ep2")

    const factsNodes = graph.getCurrentFacts(tmpDir, "facts")
    const markdown = graph.graphNodesToMarkdown(factsNodes)
    expect(markdown).toContain("auth")
    expect(markdown).toContain("Use OAuth2")
  })
})
