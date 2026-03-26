import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { readProjectMemory } from "../../src/memory.js"

describe("readProjectMemory", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-memory-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty string for missing directory", () => {
    expect(readProjectMemory(path.join(tmpDir, "nonexistent"))).toBe("")
  })

  it("returns empty string for empty directory", () => {
    const memDir = path.join(tmpDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    expect(readProjectMemory(tmpDir)).toBe("")
  })

  it("concatenates .md files with headers", () => {
    const memDir = path.join(tmpDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "architecture.md"), "Next.js app")
    fs.writeFileSync(path.join(memDir, "conventions.md"), "Uses vitest")

    const result = readProjectMemory(tmpDir)
    expect(result).toContain("## architecture")
    expect(result).toContain("Next.js app")
    expect(result).toContain("## conventions")
    expect(result).toContain("Uses vitest")
  })

  it("ignores non-.md files", () => {
    const memDir = path.join(tmpDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "notes.md"), "Important")
    fs.writeFileSync(path.join(memDir, "data.json"), '{"skip": true}')

    const result = readProjectMemory(tmpDir)
    expect(result).toContain("Important")
    expect(result).not.toContain("skip")
  })
})
