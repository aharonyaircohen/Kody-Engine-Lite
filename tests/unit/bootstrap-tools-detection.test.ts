import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { detectToolsForBootstrap } from "../../src/bin/commands/bootstrap.js"

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-bootstrap-tools-"))
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe("detectToolsForBootstrap", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("detects playwright when playwright.config.ts exists", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")
    const result = detectToolsForBootstrap(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("playwright")
    expect(result[0].skill).toBe("microsoft/playwright-cli@playwright-cli")
    expect(result[0].setup).toBe("npx playwright install --with-deps chromium")
  })

  it("detects playwright when playwright.config.js exists", () => {
    writeFile(tmpDir, "playwright.config.js", "module.exports = {}")
    const result = detectToolsForBootstrap(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("playwright")
  })

  it("returns empty when no known tools detected", () => {
    writeFile(tmpDir, "package.json", "{}")
    const result = detectToolsForBootstrap(tmpDir)
    expect(result).toEqual([])
  })

  it("returns empty for empty directory", () => {
    const result = detectToolsForBootstrap(tmpDir)
    expect(result).toEqual([])
  })

  it("each detected tool has all required fields", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")
    const result = detectToolsForBootstrap(tmpDir)
    for (const tool of result) {
      expect(tool.name).toBeTruthy()
      expect(tool.detect).toBeInstanceOf(Array)
      expect(tool.detect.length).toBeGreaterThan(0)
      expect(tool.stages).toBeInstanceOf(Array)
      expect(tool.stages.length).toBeGreaterThan(0)
      expect(typeof tool.setup).toBe("string")
      expect(tool.skill).toBeTruthy()
    }
  })
})
