/**
 * W-2 — invalidation + restore pathway.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-invalidate-"))
}

describe("invalidateFact", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns the updated node with validTo set", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Use JWT", "ep_1")
    const result = invalidateFact(projectDir, fact.id)
    expect(result).not.toBeNull()
    expect(result!.validTo).not.toBeNull()
  })

  it("returns null for missing id", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { invalidateFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)
    expect(invalidateFact(projectDir, "fact_does_not_exist")).toBeNull()
  })

  it("removes invalidated fact from getCurrentFacts", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const a = writeFact(projectDir, "facts", "auth", "A", "ep_1")
    const b = writeFact(projectDir, "facts", "auth", "B", "ep_2")
    invalidateFact(projectDir, a.id)

    const current = getCurrentFacts(projectDir)
    const ids = current.map((n) => n.id)
    expect(ids).not.toContain(a.id)
    expect(ids).toContain(b.id)
  })

  it("preserves invalidated fact for historical lookup (getFactById)", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, getFactById } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Historical fact", "ep_1")
    invalidateFact(projectDir, fact.id)

    // The node is not deleted — getFactById still finds it, just with validTo set.
    const found = getFactById(projectDir, fact.id)
    expect(found).not.toBeNull()
    expect(found!.validTo).not.toBeNull()
    expect(found!.content).toBe("Historical fact")
  })
})

describe("restoreFact", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("clears validTo on an invalidated fact", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, restoreFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Restorable", "ep_1")
    invalidateFact(projectDir, fact.id)
    const restored = restoreFact(projectDir, fact.id)
    expect(restored).not.toBeNull()
    expect(restored!.validTo).toBeNull()
  })

  it("returns null for missing id", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { restoreFact } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)
    expect(restoreFact(projectDir, "fact_ghost")).toBeNull()
  })

  it("restored fact reappears in getCurrentFacts", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    const { writeFact, invalidateFact, restoreFact, getCurrentFacts } = await import("../../src/memory/graph/queries.js")
    ensureGraphDir(projectDir)

    const fact = writeFact(projectDir, "facts", "auth", "Brought back", "ep_1")
    invalidateFact(projectDir, fact.id)
    expect(getCurrentFacts(projectDir).map((n) => n.id)).not.toContain(fact.id)

    restoreFact(projectDir, fact.id)
    expect(getCurrentFacts(projectDir).map((n) => n.id)).toContain(fact.id)
  })
})

describe("retraction episode source", () => {
  it("is a valid EpisodeSource", async () => {
    const { EpisodeSourceValues } = await import("../../src/memory/graph/types.js")
    expect(EpisodeSourceValues).toContain("retraction")
  })

  it("retraction has confidence 1.0", async () => {
    const { defaultConfidenceFor } = await import("../../src/memory/graph/confidence.js")
    expect(defaultConfidenceFor("retraction")).toBe(1.0)
  })
})
