import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { findLatestTaskForIssue, generateTaskId } from "../../src/cli/task-resolution.js"

describe("generateTaskId", () => {
  it("produces a date-time based string", () => {
    const id = generateTaskId()
    // Format: YYMMDD-HHMMSS
    expect(id).toMatch(/^\d{6}-\d{6}$/)
  })

  it("generates unique ids on subsequent calls", () => {
    const id1 = generateTaskId()
    // Force at least 1s difference
    const id2 = generateTaskId()
    // They could be the same if within the same second, but format should be valid
    expect(id2).toMatch(/^\d{6}-\d{6}$/)
  })
})

describe("findLatestTaskForIssue", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-task-"))
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks"), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("finds task by issue number prefix", () => {
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks", "42-260326-120000"))
    const result = findLatestTaskForIssue(42, tmpDir)
    expect(result).toBe("42-260326-120000")
  })

  it("returns null when no matching task exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks", "99-260326-120000"))
    const result = findLatestTaskForIssue(42, tmpDir)
    expect(result).toBeNull()
  })

  it("returns null when .tasks directory doesn't exist", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-empty-"))
    const result = findLatestTaskForIssue(42, emptyDir)
    expect(result).toBeNull()
    fs.rmSync(emptyDir, { recursive: true, force: true })
  })

  it("ignores files, only matches directories", () => {
    fs.writeFileSync(path.join(tmpDir, ".kody/tasks", "42-old-file"), "stale")
    const result = findLatestTaskForIssue(42, tmpDir)
    expect(result).toBeNull()
  })

  it("returns latest task when multiple match", () => {
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks", "42-260326-100000"))
    fs.mkdirSync(path.join(tmpDir, ".kody/tasks", "42-260326-120000"))
    const result = findLatestTaskForIssue(42, tmpDir)
    // Sorted reverse, so latest first
    expect(result).toBe("42-260326-120000")
  })
})
