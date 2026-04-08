import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { readProjectMemory, readBrainMemory, writeBrainEntry, mergeBrainWithProject, getBrainBasePath, setTestBrainPath } from "../../src/memory.js"

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

// ─── Brain Tests ─────────────────────────────────────────────────────────────

describe("getBrainBasePath", () => {
  it("returns a path in the user's home directory", () => {
    const brainPath = getBrainBasePath()
    expect(brainPath).toContain(os.homedir())
    expect(brainPath).toContain(".kody")
    expect(brainPath).toContain("brain")
  })
})

describe("readBrainMemory", () => {
  let tmpBrainDir: string

  beforeEach(() => {
    tmpBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-brain-test-"))
  })

  afterEach(() => {
    setTestBrainPath(null)
    fs.rmSync(tmpBrainDir, { recursive: true, force: true })
  })

  it("returns empty string when brain directory does not exist", () => {
    const memDir = path.join(tmpBrainDir, "memory")
    fs.mkdirSync(memDir, { recursive: true })
    setTestBrainPath(tmpBrainDir)
    // Remove the directory to simulate non-existence
    fs.rmSync(memDir, { recursive: true })
    const result = readBrainMemory()
    expect(result).toBe("")
  })

  it("returns empty string for empty brain/memory directory", () => {
    const memDir = path.join(tmpBrainDir, "memory")
    fs.mkdirSync(memDir, { recursive: true })
    setTestBrainPath(tmpBrainDir)
    const result = readBrainMemory()
    setTestBrainPath(null)
    expect(result).toBe("")
  })

  it("returns User Brain header with .md files", () => {
    const memDir = path.join(tmpBrainDir, "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "facts_user.md"), "Yair works on Kody-Engine-Lite")
    fs.writeFileSync(path.join(memDir, "preferences_workflow.md"), "always ask before acting")

    setTestBrainPath(tmpBrainDir)
    const result = readBrainMemory()
    setTestBrainPath(null)

    expect(result).toContain("# User Brain")
    expect(result).toContain("## facts_user")
    expect(result).toContain("Yair works on Kody-Engine-Lite")
    expect(result).toContain("## preferences_workflow")
    expect(result).toContain("always ask before acting")
  })

  it("ignores non-.md files in brain memory", () => {
    const memDir = path.join(tmpBrainDir, "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "facts_user.md"), "Important")
    fs.writeFileSync(path.join(memDir, "data.json"), '{"skip": true}')

    setTestBrainPath(tmpBrainDir)
    const result = readBrainMemory()
    setTestBrainPath(null)

    expect(result).toContain("Important")
    expect(result).not.toContain("skip")
  })
})

describe("writeBrainEntry", () => {
  let tmpBrainDir: string

  beforeEach(() => {
    tmpBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-brain-write-test-"))
  })

  afterEach(() => {
    setTestBrainPath(null)
    fs.rmSync(tmpBrainDir, { recursive: true, force: true })
  })

  it("creates brain directory if it does not exist", () => {
    setTestBrainPath(tmpBrainDir)
    writeBrainEntry("facts", "user", "Yair works on Kody-Engine-Lite")
    setTestBrainPath(null)

    expect(fs.existsSync(path.join(tmpBrainDir, "memory"))).toBe(true)
  })

  it("creates new file when entry does not exist", () => {
    setTestBrainPath(tmpBrainDir)
    writeBrainEntry("facts", "user", "Yair works on Kody-Engine-Lite")
    setTestBrainPath(null)

    const filePath = path.join(tmpBrainDir, "memory", "facts_user.md")
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toContain("Yair works on Kody-Engine-Lite")
  })

  it("appends to existing file", () => {
    const memDir = path.join(tmpBrainDir, "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "facts_user.md"), "- Existing entry")

    setTestBrainPath(tmpBrainDir)
    writeBrainEntry("facts", "user", "New entry")
    setTestBrainPath(null)

    const content = fs.readFileSync(path.join(memDir, "facts_user.md"), "utf-8")
    expect(content).toContain("Existing entry")
    expect(content).toContain("New entry")
  })
})

describe("mergeBrainWithProject", () => {
  let tmpProjectDir: string
  let tmpBrainDir: string

  beforeEach(() => {
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-merge-project-"))
    tmpBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-merge-brain-"))
  })

  afterEach(() => {
    setTestBrainPath(null)
    fs.rmSync(tmpProjectDir, { recursive: true, force: true })
    fs.rmSync(tmpBrainDir, { recursive: true, force: true })
  })

  it("returns empty string when both are empty", () => {
    setTestBrainPath(tmpBrainDir)
    const result = mergeBrainWithProject(tmpProjectDir)
    setTestBrainPath(null)
    expect(result).toBe("")
  })

  it("returns only project memory when brain is empty", () => {
    const memDir = path.join(tmpProjectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "architecture.md"), "Next.js app")

    setTestBrainPath(tmpBrainDir)
    const result = mergeBrainWithProject(tmpProjectDir)
    setTestBrainPath(null)
    expect(result).toContain("Next.js app")
    expect(result).not.toContain("# User Brain")
  })

  it("returns only brain when project memory is empty", () => {
    const memDir = path.join(tmpBrainDir, "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "facts_user.md"), "Yair")

    setTestBrainPath(tmpBrainDir)
    const result = mergeBrainWithProject(tmpProjectDir)
    setTestBrainPath(null)
    expect(result).toContain("# User Brain")
    expect(result).toContain("Yair")
    expect(result).not.toContain("architecture")
  })

  it("prepends brain before project memory", () => {
    const projMemDir = path.join(tmpProjectDir, ".kody", "memory")
    fs.mkdirSync(projMemDir, { recursive: true })
    fs.writeFileSync(path.join(projMemDir, "architecture.md"), "Next.js")

    const brainMemDir = path.join(tmpBrainDir, "memory")
    fs.mkdirSync(brainMemDir, { recursive: true })
    fs.writeFileSync(path.join(brainMemDir, "facts_user.md"), "Yair")

    setTestBrainPath(tmpBrainDir)
    const result = mergeBrainWithProject(tmpProjectDir)
    setTestBrainPath(null)

    const brainIdx = result.indexOf("# User Brain")
    const projMemIdx = result.indexOf("Next.js")
    expect(brainIdx).toBeLessThan(projMemIdx)
    expect(result).toContain("Yair")
    expect(result).toContain("Next.js")
  })
})
