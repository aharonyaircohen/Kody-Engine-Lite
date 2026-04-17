/**
 * W-3 — searchFactsByScope expands one hop out via related_to edges.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-scope-related-"))
}

describe("searchFactsByScope related-to expansion", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns only direct matches when no related_to edges exist", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, searchFactsByScope } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    writeFact(projectDir, "facts", "auth", "JWT auth", "ep_1")
    writeFact(projectDir, "facts", "api", "Rate limit 100", "ep_2")

    const results = searchFactsByScope(projectDir, ["src/auth/login.ts"], 5)
    expect(results).toHaveLength(1)
    expect(results[0].room).toBe("auth")
  })

  it("expands scope results with one-hop related_to neighbors", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, writeEdge, searchFactsByScope } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const authFact = writeFact(projectDir, "facts", "auth", "Use JWT for auth", "ep_1")
    const sessionFact = writeFact(projectDir, "facts", "session", "Sessions expire after 24h", "ep_2")
    writeEdge(projectDir, authFact.id, "related_to", sessionFact.id, "ep_1")

    // Scope hits auth directly; session should be pulled in via related_to.
    const results = searchFactsByScope(projectDir, ["src/auth/login.ts"], 5)
    const ids = results.map((r) => r.id)
    expect(ids).toContain(authFact.id)
    expect(ids).toContain(sessionFact.id)
  })

  it("caps expanded results at limit*2", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, writeEdge, searchFactsByScope } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const seed = writeFact(projectDir, "facts", "auth", "seed auth fact", "ep_0")
    // Six neighbors all linked to seed
    for (let i = 0; i < 6; i++) {
      const n = writeFact(projectDir, "facts", `neighbor${i}`, `neighbor content ${i}`, `ep_${i}`)
      writeEdge(projectDir, seed.id, "related_to", n.id, "ep_0")
    }

    // limit=2 → cap at 4
    const results = searchFactsByScope(projectDir, ["src/auth/login.ts"], 2)
    expect(results.length).toBeLessThanOrEqual(4)
  })

  it("excludes invalidated neighbors from expansion", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const {
      writeFact,
      writeEdge,
      invalidateFact,
      searchFactsByScope,
    } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const authFact = writeFact(projectDir, "facts", "auth", "auth fact", "ep_1")
    const sessionFact = writeFact(projectDir, "facts", "session", "session fact", "ep_2")
    writeEdge(projectDir, authFact.id, "related_to", sessionFact.id, "ep_1")

    invalidateFact(projectDir, sessionFact.id)

    const results = searchFactsByScope(projectDir, ["src/auth/login.ts"], 5)
    expect(results.map((r) => r.id)).not.toContain(sessionFact.id)
  })

  it("expandRelated:false preserves legacy behavior (no expansion)", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, writeEdge, searchFactsByScope } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const authFact = writeFact(projectDir, "facts", "auth", "auth fact", "ep_1")
    const sessionFact = writeFact(projectDir, "facts", "session", "session fact", "ep_2")
    writeEdge(projectDir, authFact.id, "related_to", sessionFact.id, "ep_1")

    const results = searchFactsByScope(projectDir, ["src/auth/login.ts"], 5, { expandRelated: false })
    expect(results.map((r) => r.id)).not.toContain(sessionFact.id)
  })
})
