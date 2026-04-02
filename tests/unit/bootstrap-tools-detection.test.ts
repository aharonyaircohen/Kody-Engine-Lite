import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { detectToolsForBootstrap, detectFrameworkSkills } from "../../src/bin/commands/bootstrap.js"

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

describe("detectFrameworkSkills", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("detects React + Next.js skills for Next.js project", () => {
    writePkg(tmpDir, { next: "14.0.0", react: "18.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    const refs = result.map((s) => s.skill)
    expect(refs).toContain("vercel-labs/agent-skills@vercel-react-best-practices")
    expect(refs).toContain("wshobson/agents@nextjs-app-router-patterns")
  })

  it("detects React (no Next.js) skills for React-only project", () => {
    writePkg(tmpDir, { react: "18.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    const refs = result.map((s) => s.skill)
    expect(refs).toContain("vercel-labs/agent-skills@vercel-react-best-practices")
    expect(refs).not.toContain("wshobson/agents@nextjs-app-router-patterns")
  })

  it("detects Vue skill", () => {
    writePkg(tmpDir, { vue: "3.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    expect(result.map((s) => s.skill)).toContain("antfu/skills@vue")
  })

  it("detects Svelte skill", () => {
    writePkg(tmpDir, { svelte: "4.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    expect(result.map((s) => s.skill)).toContain("ejirocodes/agent-skills@svelte5-best-practices")
  })

  it("detects Svelte via @sveltejs/kit", () => {
    writePkg(tmpDir, {}, { "@sveltejs/kit": "2.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    expect(result.map((s) => s.skill)).toContain("ejirocodes/agent-skills@svelte5-best-practices")
  })

  it("detects Angular skill", () => {
    writePkg(tmpDir, { "@angular/core": "17.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    expect(result.map((s) => s.skill)).toContain("analogjs/angular-skills@angular-component")
  })

  it("detects Payload CMS skill", () => {
    writePkg(tmpDir, { payload: "3.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    expect(result.map((s) => s.skill)).toContain("payloadcms/skills@payload")
  })

  it("detects Tailwind skill", () => {
    writePkg(tmpDir, {}, { tailwindcss: "3.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    expect(result.map((s) => s.skill)).toContain("wshobson/agents@tailwind-design-system")
  })

  it("detects multiple frameworks at once", () => {
    writePkg(tmpDir, { next: "14.0.0", react: "18.0.0", payload: "3.0.0" }, { tailwindcss: "3.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    const refs = result.map((s) => s.skill)
    expect(refs).toContain("vercel-labs/agent-skills@vercel-react-best-practices")
    expect(refs).toContain("wshobson/agents@nextjs-app-router-patterns")
    expect(refs).toContain("payloadcms/skills@payload")
    expect(refs).toContain("wshobson/agents@tailwind-design-system")
  })

  it("does not duplicate skills", () => {
    writePkg(tmpDir, { next: "14.0.0", react: "18.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    const refs = result.map((s) => s.skill)
    const unique = [...new Set(refs)]
    expect(refs.length).toBe(unique.length)
  })

  it("returns empty for backend-only project", () => {
    writePkg(tmpDir, { express: "4.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    expect(result).toEqual([])
  })

  it("returns empty when no package.json", () => {
    const result = detectFrameworkSkills(tmpDir)
    expect(result).toEqual([])
  })

  it("returns empty for invalid package.json", () => {
    writeFile(tmpDir, "package.json", "not json")
    const result = detectFrameworkSkills(tmpDir)
    expect(result).toEqual([])
  })

  it("each skill has skill ref and label", () => {
    writePkg(tmpDir, { next: "14.0.0", react: "18.0.0" })
    const result = detectFrameworkSkills(tmpDir)
    for (const s of result) {
      expect(s.skill).toBeTruthy()
      expect(s.skill).toContain("@")
      expect(s.label).toBeTruthy()
    }
  })
})
