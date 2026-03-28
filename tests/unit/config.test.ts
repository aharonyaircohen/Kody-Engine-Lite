import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { getProjectConfig, resetProjectConfig, setConfigDir } from "../../src/config.js"

describe("config", () => {
  let tmpDir: string

  beforeEach(() => {
    resetProjectConfig()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-config-test-"))
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns defaults when no config file", () => {
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.git.defaultBranch).toBe("dev")
    expect(config.agent.modelMap.cheap).toBe("haiku")
    expect(config.agent.defaultRunner).toBeUndefined()
  })

  it("merges user config with defaults", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({ git: { defaultBranch: "main" } }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.git.defaultBranch).toBe("main")
    expect(config.quality.typecheck).toBe("pnpm -s tsc --noEmit") // default preserved
  })

  it("caches config", () => {
    setConfigDir(tmpDir)
    const config1 = getProjectConfig()
    const config2 = getProjectConfig()
    expect(config1).toBe(config2) // same object reference
  })

  it("resetProjectConfig clears cache", () => {
    setConfigDir(tmpDir)
    const config1 = getProjectConfig()
    resetProjectConfig()
    setConfigDir(tmpDir)
    const config2 = getProjectConfig()
    expect(config1).not.toBe(config2)
  })

  it("handles invalid JSON gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), "not json")
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.git.defaultBranch).toBe("dev") // falls back to defaults
  })

  it("parses runners config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: {
          defaultRunner: "claude",
          runners: {
            claude: { type: "claude-code" },
            backup: { type: "claude-code" },
          },
          stageRunners: { plan: "backup", build: "claude" },
        },
      }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.agent.defaultRunner).toBe("claude")
    expect(config.agent.runners?.claude.type).toBe("claude-code")
    expect(config.agent.stageRunners?.plan).toBe("backup")
  })
})
