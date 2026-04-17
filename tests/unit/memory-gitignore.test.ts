/**
 * Fix #4 — ensureGraphGitignore + untrackGraphArtifacts.
 *
 * Verifies target-repo gitignore management for graph transient files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execFileSync } from "child_process"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-gitignore-"))
}

function initGit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" })
}

describe("ensureGraphGitignore", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("creates .gitignore with all entries when none exists", async () => {
    const { ensureGraphGitignore, GRAPH_GITIGNORE_ENTRIES } = await import("../../src/memory/graph/gitignore.js")
    const modified = ensureGraphGitignore(projectDir)
    expect(modified).toBe(true)
    const content = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8")
    for (const e of GRAPH_GITIGNORE_ENTRIES) {
      expect(content).toContain(e)
    }
  })

  it("appends missing entries without destroying existing content", async () => {
    const existing = "node_modules/\ndist/\n.env\n"
    fs.writeFileSync(path.join(projectDir, ".gitignore"), existing)
    const { ensureGraphGitignore } = await import("../../src/memory/graph/gitignore.js")
    ensureGraphGitignore(projectDir)
    const after = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8")
    expect(after.startsWith(existing)).toBe(true) // existing content intact
    expect(after).toContain(".kody/graph/.graph-lock")
    expect(after).toContain(".kody/graph/*.bak")
  })

  it("is idempotent — second call does nothing when entries already present", async () => {
    const { ensureGraphGitignore } = await import("../../src/memory/graph/gitignore.js")
    const first = ensureGraphGitignore(projectDir)
    expect(first).toBe(true)
    const snapshot = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8")

    const second = ensureGraphGitignore(projectDir)
    expect(second).toBe(false)
    expect(fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8")).toBe(snapshot)
  })

  it("tolerates negated (!) entries without duplicating", async () => {
    // Engine's own repo negates nodes.json / edges.json to track them;
    // we must not duplicate-add them.
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "!.kody/graph/.graph-lock\n")
    const { ensureGraphGitignore } = await import("../../src/memory/graph/gitignore.js")
    ensureGraphGitignore(projectDir)
    const content = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8")
    const occurrences = (content.match(/\.kody\/graph\/\.graph-lock$/gm) ?? []).length
    // One negated, potentially one bare if added — not more than two
    expect(occurrences).toBeLessThanOrEqual(2)
  })

  it("appends only the missing subset, not the whole block", async () => {
    // Pre-populate with some (not all) entries
    fs.writeFileSync(
      path.join(projectDir, ".gitignore"),
      "node_modules/\n.kody/graph/.graph-lock\n.kody/graph/*.bak\n",
    )
    const { ensureGraphGitignore } = await import("../../src/memory/graph/gitignore.js")
    ensureGraphGitignore(projectDir)
    const content = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8")
    // Still present, not duplicated
    expect((content.match(/^\.kody\/graph\/\.graph-lock$/gm) ?? []).length).toBe(1)
    expect((content.match(/^\.kody\/graph\/\*\.bak$/gm) ?? []).length).toBe(1)
    // Missing one added
    expect(content).toContain(".kody/graph/*.tmp.*")
  })
})

describe("untrackGraphArtifacts", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
    initGit(projectDir)
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("returns empty list when no artifacts tracked", async () => {
    const { untrackGraphArtifacts } = await import("../../src/memory/graph/gitignore.js")
    const result = untrackGraphArtifacts(projectDir)
    expect(result).toEqual([])
  })

  it("untracks committed .graph-lock sentinel without deleting from disk", async () => {
    const graphDir = path.join(projectDir, ".kody", "graph")
    fs.mkdirSync(graphDir, { recursive: true })
    const lockFile = path.join(graphDir, ".graph-lock")
    fs.writeFileSync(lockFile, "")

    execFileSync("git", ["add", "-f", ".kody/graph/.graph-lock"], { cwd: projectDir, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: projectDir, stdio: "pipe" })

    const { untrackGraphArtifacts } = await import("../../src/memory/graph/gitignore.js")
    const untracked = untrackGraphArtifacts(projectDir)

    expect(untracked).toContain(".kody/graph/.graph-lock")
    expect(fs.existsSync(lockFile)).toBe(true) // still on disk

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: projectDir, encoding: "utf-8",
    }).trim()
    expect(staged).toContain(".kody/graph/.graph-lock") // staged as "delete from index"
  })

  it("tolerates a non-git directory without throwing", async () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "kody-nogit-"))
    try {
      fs.mkdirSync(path.join(noGit, ".kody", "graph"), { recursive: true })
      fs.writeFileSync(path.join(noGit, ".kody", "graph", ".graph-lock"), "")
      const { untrackGraphArtifacts } = await import("../../src/memory/graph/gitignore.js")
      const result = untrackGraphArtifacts(noGit)
      expect(result).toEqual([])
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true })
    }
  })
})
