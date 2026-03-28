import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { checkCommand, checkFile } from "../../src/bin/cli.js"

describe("checkCommand", () => {
  it("returns ok for available command", () => {
    const result = checkCommand("node", ["--version"], "Install node")
    expect(result.ok).toBe(true)
    expect(result.name).toBe("node CLI")
    expect(result.detail).toBeDefined()
  })

  it("returns not ok for missing command", () => {
    const result = checkCommand("nonexistent-binary-xyz", ["--version"], "Install it")
    expect(result.ok).toBe(false)
    expect(result.fix).toBe("Install it")
  })

  it("captures version detail", () => {
    const result = checkCommand("node", ["--version"], "Install node")
    expect(result.ok).toBe(true)
    // Node version starts with v
    expect(result.detail).toMatch(/^v\d+/)
  })
})

describe("checkFile", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-check-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns ok when file exists", () => {
    const filePath = path.join(tmpDir, "package.json")
    fs.writeFileSync(filePath, "{}")
    const result = checkFile(filePath, "package.json", "Run: pnpm init")
    expect(result.ok).toBe(true)
    expect(result.detail).toBe(filePath)
  })

  it("returns not ok when file missing", () => {
    const filePath = path.join(tmpDir, "missing.json")
    const result = checkFile(filePath, "missing.json", "Create it")
    expect(result.ok).toBe(false)
    expect(result.fix).toBe("Create it")
  })
})
