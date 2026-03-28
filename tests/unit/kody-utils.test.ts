import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { ensureTaskDir } from "../../src/kody-utils.js"

describe("ensureTaskDir", () => {
  const origCwd = process.cwd()
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-utils-test-"))
    process.chdir(tmpDir)
  })

  afterEach(() => {
    process.chdir(origCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates .kody/tasks/<id> directory", () => {
    const dir = ensureTaskDir("test-123")
    expect(fs.existsSync(dir)).toBe(true)
    expect(dir).toContain(".kody/tasks")
    expect(dir).toContain("test-123")
  })

  it("is idempotent", () => {
    const dir1 = ensureTaskDir("test-456")
    const dir2 = ensureTaskDir("test-456")
    expect(dir1).toBe(dir2)
    expect(fs.existsSync(dir1)).toBe(true)
  })
})
