import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// Mock child_process before importing tools.ts
const execSyncMock = vi.fn()
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>()
  return { ...actual, execSync: (...args: unknown[]) => execSyncMock(...args) }
})

import { loadToolDeclarations, detectTools, runToolSetup } from "../../src/tools.js"

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
`)
    const result = loadToolDeclarations(tmpDir)
    expect(result).toHaveLength(2)
    expect(result[1].name).toBe("vitest")
    expect(result[1].stages).toEqual(["verify", "review"])
  })

  it("ignores skill field in YAML (no longer used)", () => {
    writeFile(tmpDir, ".kody/tools.yml", `playwright:
  detect: ["playwright.config.ts"]
  stages: [verify]
  setup: ""
  skill: custom.md
`)
    const result = loadToolDeclarations(tmpDir)
    expect(result[0]).not.toHaveProperty("skill")
  })
})

describe("detectTools", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns only tools whose detect patterns match", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "" },
      { name: "vitest", detect: ["vitest.config.ts"], stages: ["verify"], setup: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("playwright")
  })

  it("returns empty array when no patterns match", () => {
    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result).toEqual([])
  })

  it("matches any detect pattern (OR logic)", () => {
    writeFile(tmpDir, "playwright.config.js", "module.exports = {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts", "playwright.config.js"], stages: ["verify"], setup: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result).toHaveLength(1)
  })

  it("does not include skillContent in resolved tools", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result[0]).not.toHaveProperty("skillContent")
  })
})

describe("runToolSetup", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
    execSyncMock.mockReset()
  })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("runs setup command and installs skill from skills.sh", () => {
    const tools = [{ name: "playwright", stages: ["verify"], setup: "echo setup" }]
    runToolSetup(tools, tmpDir)

    expect(execSyncMock).toHaveBeenCalledTimes(2)

    // First call: setup command
    expect(execSyncMock).toHaveBeenCalledWith(
      "echo setup",
      expect.objectContaining({ cwd: tmpDir }),
    )

    // Second call: skills.sh install
    expect(execSyncMock).toHaveBeenCalledWith(
      "npx skills add --skill playwright --yes",
      expect.objectContaining({ cwd: tmpDir }),
    )
  })

  it("installs skill even when setup is empty", () => {
    const tools = [{ name: "vitest", stages: ["verify"], setup: "" }]
    runToolSetup(tools, tmpDir)

    // Should only call skills install (no setup command)
    expect(execSyncMock).toHaveBeenCalledTimes(1)
    expect(execSyncMock).toHaveBeenCalledWith(
      "npx skills add --skill vitest --yes",
      expect.objectContaining({ cwd: tmpDir }),
    )
  })

  it("continues on skill install failure", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("npx not found")
    })

    const tools = [{ name: "playwright", stages: ["verify"], setup: "echo setup" }]
    // Should not throw
    expect(() => runToolSetup(tools, tmpDir)).not.toThrow()
  })

  it("installs skills for multiple tools", () => {
    const tools = [
      { name: "playwright", stages: ["verify"], setup: "echo pw" },
      { name: "vitest", stages: ["verify"], setup: "" },
    ]
    runToolSetup(tools, tmpDir)

    // playwright: setup + skill = 2 calls, vitest: skill only = 1 call
    expect(execSyncMock).toHaveBeenCalledTimes(3)
    expect(execSyncMock).toHaveBeenCalledWith(
      "npx skills add --skill playwright --yes",
      expect.objectContaining({ cwd: tmpDir }),
    )
    expect(execSyncMock).toHaveBeenCalledWith(
      "npx skills add --skill vitest --yes",
      expect.objectContaining({ cwd: tmpDir }),
    )
  })
})
