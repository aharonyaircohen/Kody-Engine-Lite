import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { getProjectConfig, resetProjectConfig, setConfigDir, getAnthropicApiKeyOrDummy, resolveStageConfig } from "../../src/config.js"

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
    expect(config.agent.modelMap).toEqual({})
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

describe("getAnthropicApiKeyOrDummy", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it("returns real key when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-real-key-123"
    expect(getAnthropicApiKeyOrDummy()).toBe("sk-ant-real-key-123")
  })

  it("returns dummy key when ANTHROPIC_API_KEY is not set", () => {
    delete process.env.ANTHROPIC_API_KEY
    const key = getAnthropicApiKeyOrDummy()
    expect(key).toMatch(/^sk-ant-api03-0{64}$/)
  })

  it("returns dummy key when ANTHROPIC_API_KEY is empty string", () => {
    process.env.ANTHROPIC_API_KEY = ""
    const key = getAnthropicApiKeyOrDummy()
    expect(key).toMatch(/^sk-ant-api03-0{64}$/)
  })
})

describe("resolveStageConfig", () => {
  it("throws when model tier is missing from empty modelMap", () => {
    const config = {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { modelMap: {} },
    }
    expect(() => resolveStageConfig(config, "build", "cheap")).toThrow(
      /No model configured for stage 'build'/,
    )
  })

  it("resolves model from modelMap when configured", () => {
    const config = {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { modelMap: { cheap: "minimax/MiniMax-M2.7-highspeed" }, provider: "minimax" },
    }
    const result = resolveStageConfig(config, "build", "cheap")
    expect(result.model).toBe("minimax/MiniMax-M2.7-highspeed")
    expect(result.provider).toBe("minimax")
  })
})
