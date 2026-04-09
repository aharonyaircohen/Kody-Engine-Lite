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
  skill: "microsoft/playwright-cli@playwright-cli"
`

describe("loadToolDeclarations", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns empty array when .kody/tools.yml does not exist", () => {
    const result = loadToolDeclarations(tmpDir)
    expect(result).toEqual([])
  })

  it("parses tools.yml into declarations with skill field", () => {
    writeFile(tmpDir, ".kody/tools.yml", SAMPLE_TOOLS_YML)
    const result = loadToolDeclarations(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: "playwright",
      detect: ["playwright.config.ts", "playwright.config.js"],
      stages: ["verify"],
      setup: "npx playwright install --with-deps chromium",
      skill: "microsoft/playwright-cli@playwright-cli",
    })
  })

  it("returns undefined skill when field is omitted", () => {
    writeFile(tmpDir, ".kody/tools.yml", `vitest:
  detect: ["vitest.config.ts"]
  stages: [verify]
  setup: ""
`)
    const result = loadToolDeclarations(tmpDir)
    expect(result[0].skill).toBeUndefined()
  })

  it("parses run field when present", () => {
    writeFile(tmpDir, ".kody/tools.yml", `playwright:
  detect: ["playwright.config.ts"]
  stages: [verify]
  setup: "npx playwright install"
  skill: "microsoft/playwright-cli@playwright-cli"
  run: "npx playwright test"
`)
    const result = loadToolDeclarations(tmpDir)
    expect(result[0].run).toBe("npx playwright test")
  })

  it("returns undefined run when field is omitted", () => {
    writeFile(tmpDir, ".kody/tools.yml", `vitest:
  detect: ["vitest.config.ts"]
  stages: [verify]
  setup: ""
`)
    const result = loadToolDeclarations(tmpDir)
    expect(result[0].run).toBeUndefined()
  })

  it("returns empty array for invalid YAML", () => {
    writeFile(tmpDir, ".kody/tools.yml", ":::invalid:::")
    const result = loadToolDeclarations(tmpDir)
    expect(result).toEqual([])
  })

  it("parses multiple tools with mixed skill presence", () => {
    writeFile(tmpDir, ".kody/tools.yml", `${SAMPLE_TOOLS_YML}
vitest:
  detect: ["vitest.config.ts"]
  stages: [verify, review]
  setup: ""
`)
    const result = loadToolDeclarations(tmpDir)
    expect(result).toHaveLength(2)
    expect(result[0].skill).toBe("microsoft/playwright-cli@playwright-cli")
    expect(result[1].skill).toBeUndefined()
  })
})

describe("detectTools", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns only tools whose detect patterns match", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "", skill: "microsoft/playwright-cli@playwright-cli" },
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

  it("propagates skill field to resolved tool", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "", skill: "microsoft/playwright-cli@playwright-cli" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result[0].skill).toBe("microsoft/playwright-cli@playwright-cli")
  })

  it("propagates run field to resolved tool", () => {
    writeFile(tmpDir, "playwright.config.ts", "export default {}")

    const declarations = [
      { name: "playwright", detect: ["playwright.config.ts"], stages: ["verify"], setup: "", run: "npx playwright test" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result[0].run).toBe("npx playwright test")
  })

  it("resolved tool has undefined skill when not declared", () => {
    writeFile(tmpDir, "vitest.config.ts", "export default {}")

    const declarations = [
      { name: "vitest", detect: ["vitest.config.ts"], stages: ["verify"], setup: "" },
    ]

    const result = detectTools(declarations, tmpDir)
    expect(result[0].skill).toBeUndefined()
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
    const tools = [{
      name: "playwright",
      stages: ["verify"],
      setup: "echo setup",
      skill: "microsoft/playwright-cli@playwright-cli",
    }]
    runToolSetup(tools, tmpDir)

    expect(execSyncMock).toHaveBeenCalledTimes(2)

    // First call: setup command
    expect(execSyncMock).toHaveBeenCalledWith(
      "echo setup",
      expect.objectContaining({ cwd: tmpDir }),
    )

    // Second call: skills.sh install with full package ref
    expect(execSyncMock).toHaveBeenCalledWith(
      "npx skills add microsoft/playwright-cli@playwright-cli --yes",
      expect.objectContaining({ cwd: tmpDir }),
    )
  })

  it("skips skill install when skill field is omitted", () => {
    const tools = [{ name: "vitest", stages: ["verify"], setup: "echo setup" }]
    runToolSetup(tools, tmpDir)

    // Only setup command, no skill install
    expect(execSyncMock).toHaveBeenCalledTimes(1)
    expect(execSyncMock).toHaveBeenCalledWith(
      "echo setup",
      expect.objectContaining({ cwd: tmpDir }),
    )
  })

  it("installs skill even when setup is empty", () => {
    const tools = [{
      name: "react-patterns",
      stages: ["build"],
      setup: "",
      skill: "vercel-labs/agent-skills@vercel-react-best-practices",
    }]
    runToolSetup(tools, tmpDir)

    // Only skill install (no setup command)
    expect(execSyncMock).toHaveBeenCalledTimes(1)
    expect(execSyncMock).toHaveBeenCalledWith(
      "npx skills add vercel-labs/agent-skills@vercel-react-best-practices --yes",
      expect.objectContaining({ cwd: tmpDir }),
    )
  })

  it("does nothing when both setup and skill are empty/missing", () => {
    const tools = [{ name: "noop", stages: ["verify"], setup: "" }]
    runToolSetup(tools, tmpDir)

    expect(execSyncMock).toHaveBeenCalledTimes(0)
  })

  it("continues on setup failure, still installs skill", () => {
    execSyncMock
      .mockImplementationOnce(() => { throw new Error("setup failed") })
      .mockImplementationOnce(() => "ok")

    const tools = [{
      name: "playwright",
      stages: ["verify"],
      setup: "bad-command",
      skill: "microsoft/playwright-cli@playwright-cli",
    }]

    expect(() => runToolSetup(tools, tmpDir)).not.toThrow()
    // Both calls attempted: failed setup + skill install
    expect(execSyncMock).toHaveBeenCalledTimes(2)
    expect(execSyncMock).toHaveBeenCalledWith(
      "npx skills add microsoft/playwright-cli@playwright-cli --yes",
      expect.objectContaining({ cwd: tmpDir }),
    )
  })

  it("continues on skill install failure", () => {
    execSyncMock
      .mockImplementationOnce(() => "ok")
      .mockImplementationOnce(() => { throw new Error("skill not found") })

    const tools = [{
      name: "playwright",
      stages: ["verify"],
      setup: "echo setup",
      skill: "nonexistent/skill@bad",
    }]

    expect(() => runToolSetup(tools, tmpDir)).not.toThrow()
  })

  it("handles multiple tools with different skill configs", () => {
    const tools = [
      { name: "playwright", stages: ["verify"], setup: "echo pw", skill: "microsoft/playwright-cli@playwright-cli" },
      { name: "vitest", stages: ["verify"], setup: "echo vt" },
      { name: "react", stages: ["build"], setup: "", skill: "vercel-labs/agent-skills@vercel-react-best-practices" },
    ]
    runToolSetup(tools, tmpDir)

    // playwright: setup + skill = 2, vitest: setup only = 1, react: skill only = 1
    expect(execSyncMock).toHaveBeenCalledTimes(4)
    expect(execSyncMock).toHaveBeenCalledWith("echo pw", expect.anything())
    expect(execSyncMock).toHaveBeenCalledWith("npx skills add microsoft/playwright-cli@playwright-cli --yes", expect.anything())
    expect(execSyncMock).toHaveBeenCalledWith("echo vt", expect.anything())
    expect(execSyncMock).toHaveBeenCalledWith("npx skills add vercel-labs/agent-skills@vercel-react-best-practices --yes", expect.anything())
  })
})
