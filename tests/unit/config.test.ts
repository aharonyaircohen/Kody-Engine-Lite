import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  getProjectConfig,
  resetProjectConfig,
  setConfigDir,
  getAnthropicApiKeyOrDummy,
  resolveStageConfig,
  applyModelOverrides,
  parseProviderModel,
  anyStageNeedsProxy,
  stageNeedsProxy,
} from "../../src/config.js"

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

  it("loads provider/model strings in modelMap", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: {
          modelMap: {
            cheap: "minimax/MiniMax-M2.7-highspeed",
            mid: "claude/claude-sonnet-4-6",
          },
        },
      }),
    )
    setConfigDir(tmpDir)
    const config = getProjectConfig()
    expect(config.agent.modelMap.cheap).toBe("minimax/MiniMax-M2.7-highspeed")
    expect(config.agent.modelMap.mid).toBe("claude/claude-sonnet-4-6")
  })
})

describe("parseProviderModel", () => {
  it("parses provider/model strings", () => {
    expect(parseProviderModel("minimax/MiniMax-M2.7-highspeed")).toEqual({
      provider: "minimax",
      model: "MiniMax-M2.7-highspeed",
    })
    expect(parseProviderModel("claude/claude-sonnet-4-6")).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
    })
  })

  it("preserves slashes after the first one in the model name", () => {
    expect(parseProviderModel("openai/o1/preview")).toEqual({
      provider: "openai",
      model: "o1/preview",
    })
  })

  it("throws on missing slash", () => {
    expect(() => parseProviderModel("MiniMax-M1")).toThrow(/expected 'provider\/model'/)
  })

  it("throws on empty string", () => {
    expect(() => parseProviderModel("")).toThrow(/expected 'provider\/model'/)
  })

  it("throws on leading slash (empty provider)", () => {
    expect(() => parseProviderModel("/foo")).toThrow(/expected 'provider\/model'/)
  })

  it("throws on trailing slash (empty model)", () => {
    expect(() => parseProviderModel("foo/")).toThrow(/expected 'provider\/model'/)
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
  function baseConfig(agent: Record<string, unknown> = { modelMap: {} }): ReturnType<typeof getProjectConfig> {
    return {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: agent as ReturnType<typeof getProjectConfig>["agent"],
    }
  }

  it("throws when no model is configured for the requested tier", () => {
    expect(() => resolveStageConfig(baseConfig(), "build", "cheap")).toThrow(
      /No model configured for stage 'build'/,
    )
  })

  it("resolves from modelMap when only modelMap is set", () => {
    const config = baseConfig({
      modelMap: { cheap: "minimax/MiniMax-M2.7-highspeed" },
    })
    const result = resolveStageConfig(config, "build", "cheap")
    expect(result).toEqual({ provider: "minimax", model: "MiniMax-M2.7-highspeed" })
  })

  it("resolves from agent.default when set, ignoring modelMap", () => {
    const config = baseConfig({
      modelMap: { cheap: "minimax/MiniMax-M1" },
      default: "claude/claude-sonnet-4-6",
    })
    const result = resolveStageConfig(config, "build", "cheap")
    expect(result).toEqual({ provider: "claude", model: "claude-sonnet-4-6" })
  })

  it("resolves per-stage override over agent.default", () => {
    const config = baseConfig({
      modelMap: { cheap: "minimax/MiniMax-M1" },
      default: "claude/claude-sonnet-4-6",
      stages: { plan: "openai/gpt-4o" },
    })
    expect(resolveStageConfig(config, "plan", "strong")).toEqual({
      provider: "openai",
      model: "gpt-4o",
    })
    expect(resolveStageConfig(config, "build", "cheap")).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
    })
  })

  it("throws on malformed modelMap entry", () => {
    const config = baseConfig({ modelMap: { cheap: "no-slash" } })
    expect(() => resolveStageConfig(config, "build", "cheap")).toThrow(/expected 'provider\/model'/)
  })
})

describe("applyModelOverrides", () => {
  function makeConfig(overrides?: Record<string, unknown>): ReturnType<typeof getProjectConfig> {
    return {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: {
        modelMap: {
          cheap: "minimax/MiniMax-M2.7-highspeed",
          mid: "minimax/MiniMax-M2.7-highspeed",
          strong: "minimax/MiniMax-M2.7-highspeed",
        },
        ...overrides,
      },
    } as ReturnType<typeof getProjectConfig>
  }

  it("does nothing when model is not specified", () => {
    const config = makeConfig()
    applyModelOverrides(config, undefined)
    expect(config.agent.default).toBeUndefined()
    expect(config.agent.modelMap.mid).toBe("minimax/MiniMax-M2.7-highspeed")
  })

  it("rewrites default + every modelMap tier with the override", () => {
    const config = makeConfig()
    applyModelOverrides(config, "claude/claude-sonnet-4-6")
    expect(config.agent.default).toBe("claude/claude-sonnet-4-6")
    expect(config.agent.modelMap.cheap).toBe("claude/claude-sonnet-4-6")
    expect(config.agent.modelMap.mid).toBe("claude/claude-sonnet-4-6")
    expect(config.agent.modelMap.strong).toBe("claude/claude-sonnet-4-6")
  })

  it("clears per-stage overrides so the override applies uniformly", () => {
    const config = makeConfig({
      stages: {
        build: "openai/gpt-4o",
        review: "google/gemini-2.5-flash",
      },
    })
    applyModelOverrides(config, "claude/claude-sonnet-4-6")
    expect(config.agent.stages).toBeUndefined()
    const buildConfig = resolveStageConfig(config, "build", "mid")
    expect(buildConfig).toEqual({ provider: "claude", model: "claude-sonnet-4-6" })
    const reviewConfig = resolveStageConfig(config, "review", "strong")
    expect(reviewConfig).toEqual({ provider: "claude", model: "claude-sonnet-4-6" })
  })

  it("rejects malformed override eagerly", () => {
    const config = makeConfig()
    expect(() => applyModelOverrides(config, "no-slash")).toThrow(/expected 'provider\/model'/)
  })
})

describe("stageNeedsProxy / anyStageNeedsProxy", () => {
  function cfg(agent: Record<string, unknown>): ReturnType<typeof getProjectConfig> {
    return {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: agent as ReturnType<typeof getProjectConfig>["agent"],
    }
  }

  it("treats claude/anthropic providers as direct (no proxy)", () => {
    expect(stageNeedsProxy({ provider: "claude", model: "x" })).toBe(false)
    expect(stageNeedsProxy({ provider: "anthropic", model: "x" })).toBe(false)
  })

  it("treats every other provider as needing proxy", () => {
    expect(stageNeedsProxy({ provider: "minimax", model: "x" })).toBe(true)
    expect(stageNeedsProxy({ provider: "openai", model: "x" })).toBe(true)
  })

  it("anyStageNeedsProxy returns true when modelMap has a non-claude entry", () => {
    expect(anyStageNeedsProxy(cfg({ modelMap: { cheap: "minimax/MiniMax-M1" } }))).toBe(true)
  })

  it("anyStageNeedsProxy returns false when every model is claude", () => {
    expect(anyStageNeedsProxy(cfg({
      modelMap: { cheap: "claude/claude-haiku-4-5", mid: "claude/claude-sonnet-4-6" },
    }))).toBe(false)
  })

  it("anyStageNeedsProxy returns true when default is non-claude", () => {
    expect(anyStageNeedsProxy(cfg({
      modelMap: { cheap: "claude/claude-haiku-4-5" },
      default: "openai/gpt-4o",
    }))).toBe(true)
  })

  it("anyStageNeedsProxy returns true when any stage override is non-claude", () => {
    expect(anyStageNeedsProxy(cfg({
      modelMap: { cheap: "claude/claude-haiku-4-5" },
      stages: { build: "google/gemini-2.5-flash" },
    }))).toBe(true)
  })
})
