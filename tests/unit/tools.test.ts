import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { loadToolDeclarations, detectTools, getToolSkillsForStage } from "../../src/tools.js"
import type { ResolvedTool } from "../../src/types.js"

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-tools-"))
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

const SAMPLE_TOOLS_YML = `playwright:
  detect: ["playwright.config.ts", "playwright.config.js"]
  stages: [verify]
  setup: "npx playwright install --with-deps chromium"
  skill: playwright-cli.md
`

describe("loadToolDeclarations", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns empty array when .kody/tools.yml does not exist", () => {
    const result = loadToolDeclarations(tmpDir)
    expect(result).toEqual([])
  })

  it("parses tools.yml into declarations", () => {
    writeFile(tmpDir, ".kody/tools.yml", SAMPLE_TOOLS_YML)
    const result = loadToolDeclarations(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: "playwright",
      detect: ["playwright.config.ts", "playwright.config.js"],
      stages: ["verify"],
      setup: "npx playwright install --with-deps chromium",
      skill: "playwright-cli.md",
    })
  })

  it("returns empty array for invalid YAML", () => {
    writeFile(tmpDir, ".kody/tools.yml", ":::invalid:::")
    const result = loadToolDeclarations(tmpDir)
    expect(result).toEqual([])
  })

  it("parses multiple tools", () => {
    writeFile(tmpDir, ".kody/tools.yml", `${SAMPLE_TOOLS_YML}
vitest:
  detect: ["vitest.config.ts"]
  stages: [verify, review]
  setup: ""
  skill: vitest.md
`)
    const result = loadToolDeclarations(tmpDir)
    expect(result).toHaveLength(2)
    expect(result[1].name).toBe("vitest")
    expect(result[1].stages).toEqual(["verify", "review"])
  })
})

describe("detectTools", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns only tools whose detect patterns match", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "", skill: "" },
      { name: "vitest", detect: ["vitest.config.ts"], stages: ["verify"], setup: "", skill: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("playwright")
  })

  it("returns empty array when no patterns match", () => {
    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "", skill: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result).toEqual([])
  })

  it("resolves skill content from project .kody/skills/ first", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")
    writeFile(tmpDir, ".kody/skills/my-skill.md", "# Project-level skill")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "", skill: "my-skill.md" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result[0].skillContent).toBe("# Project-level skill")
  })

  it("resolves skill content from engine skills/ as fallback", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "", skill: "playwright-cli.md" },
    ]

    const result = detectTools(declarations, tmpDir)
    // Engine skill file exists at skills/playwright-cli.md
    expect(result[0].skillContent).toContain("Playwright CLI")
  })

  it("matches any detect pattern (OR logic)", () => {
    writeFile(tmpDir, "playwright.config.js", "module.exports = {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts", "playwright.config.js"], stages: ["verify"], setup: "", skill: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result).toHaveLength(1)
  })
})

describe("getToolSkillsForStage", () => {
  const tools: ResolvedTool[] = [
    { name: "playwright", stages: ["verify"], setup: "", skillContent: "Use Playwright for E2E tests." },
    { name: "vitest", stages: ["verify", "review"], setup: "", skillContent: "Use Vitest for unit tests." },
    { name: "eslint", stages: ["review"], setup: "", skillContent: "Use ESLint for linting." },
  ]

  it("returns skills matching the stage", () => {
    const result = getToolSkillsForStage(tools, "verify")
    expect(result).toContain("## Available Tools")
    expect(result).toContain("### playwright")
    expect(result).toContain("Use Playwright for E2E tests.")
    expect(result).toContain("### vitest")
    expect(result).toContain("Use Vitest for unit tests.")
    expect(result).not.toContain("eslint")
  })

  it("returns empty string when no tools match the stage", () => {
    const result = getToolSkillsForStage(tools, "build")
    expect(result).toBe("")
  })

  it("concatenates multiple tool skills", () => {
    const result = getToolSkillsForStage(tools, "review")
    expect(result).toContain("### vitest")
    expect(result).toContain("### eslint")
    expect(result).not.toContain("### playwright")
  })

  it("skips tools with empty skill content", () => {
    const toolsWithEmpty: ResolvedTool[] = [
      { name: "empty", stages: ["verify"], setup: "", skillContent: "" },
      { name: "valid", stages: ["verify"], setup: "", skillContent: "Valid content." },
    ]
    const result = getToolSkillsForStage(toolsWithEmpty, "verify")
    expect(result).toContain("### valid")
    expect(result).not.toContain("### empty")
  })

  it("returns empty string for empty tools array", () => {
    const result = getToolSkillsForStage([], "verify")
    expect(result).toBe("")
  })
})
