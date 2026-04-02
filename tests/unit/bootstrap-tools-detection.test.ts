import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { detectToolsForBootstrap, detectProjectKeywords, searchSkills } from "../../src/bin/commands/bootstrap.js"

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-bootstrap-tools-"))
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function writePkg(dir: string, deps: Record<string, string>, devDeps?: Record<string, string>): void {
  writeFile(dir, "package.json", JSON.stringify({
    dependencies: deps,
    devDependencies: devDeps ?? {},
  }))
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
  })

  it("detects playwright when playwright.config.js exists", () => {
    writeFile(tmpDir, "playwright.config.js", "module.exports = {}")
    const result = detectToolsForBootstrap(tmpDir)
    expect(result).toHaveLength(1)
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
      expect(tool.stages).toBeInstanceOf(Array)
      expect(typeof tool.setup).toBe("string")
      expect(tool.skill).toBeTruthy()
    }
  })
})

describe("detectProjectKeywords", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("detects Next.js and React keywords", () => {
    writePkg(tmpDir, { next: "14.0.0", react: "18.0.0" })
    const result = detectProjectKeywords(tmpDir)
    expect(result).toContain("nextjs")
    expect(result).toContain("react")
  })

  it("detects Vue", () => {
    writePkg(tmpDir, { vue: "3.0.0" })
    expect(detectProjectKeywords(tmpDir)).toContain("vue")
  })

  it("detects Svelte", () => {
    writePkg(tmpDir, { svelte: "4.0.0" })
    expect(detectProjectKeywords(tmpDir)).toContain("svelte")
  })

  it("detects Angular", () => {
    writePkg(tmpDir, { "@angular/core": "17.0.0" })
    expect(detectProjectKeywords(tmpDir)).toContain("angular")
  })

  it("detects Payload CMS", () => {
    writePkg(tmpDir, { payload: "3.0.0" })
    expect(detectProjectKeywords(tmpDir)).toContain("payload cms")
  })

  it("detects Tailwind from devDependencies", () => {
    writePkg(tmpDir, {}, { tailwindcss: "3.0.0" })
    expect(detectProjectKeywords(tmpDir)).toContain("tailwind")
  })

  it("detects multiple frameworks", () => {
    writePkg(tmpDir, { next: "14.0.0", react: "18.0.0", payload: "3.0.0" }, { tailwindcss: "3.0.0" })
    const result = detectProjectKeywords(tmpDir)
    expect(result).toContain("nextjs")
    expect(result).toContain("react")
    expect(result).toContain("payload cms")
    expect(result).toContain("tailwind")
  })

  it("returns empty for backend-only project", () => {
    writePkg(tmpDir, { lodash: "4.0.0" })
    expect(detectProjectKeywords(tmpDir)).toEqual([])
  })

  it("returns empty when no package.json", () => {
    expect(detectProjectKeywords(tmpDir)).toEqual([])
  })

  it("returns empty for invalid package.json", () => {
    writeFile(tmpDir, "package.json", "not json")
    expect(detectProjectKeywords(tmpDir)).toEqual([])
  })
})

describe("searchSkills", () => {
  it("excludes skills in the exclude set", () => {
    const exclude = new Set(["playwright-cli", "some-other"])
    // This calls the real skills.sh API — only run if network available
    // The key behavior: excluded names should not appear in results
    const results = searchSkills(["playwright"], exclude, 5)
    for (const r of results) {
      expect(exclude.has(r.name)).toBe(false)
    }
  })

  it("respects the limit parameter", () => {
    const results = searchSkills(["react"], new Set(), 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it("returns empty for nonsense keyword", () => {
    const results = searchSkills(["xyzzy999nonexistent"], new Set(), 5)
    expect(results).toEqual([])
  })

  it("deduplicates across multiple keywords", () => {
    const results = searchSkills(["react", "nextjs"], new Set(), 10)
    const refs = results.map((r) => r.ref)
    const unique = [...new Set(refs)]
    expect(refs.length).toBe(unique.length)
  })
})
