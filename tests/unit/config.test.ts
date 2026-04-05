import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { getProjectConfig, resetProjectConfig, setConfigDir, getAnthropicApiKeyOrDummy, resolveStageConfig, applyModelOverrides } from "../../src/config.js"

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

describe("applyModelOverrides", () => {
  function makeConfig(overrides?: Record<string, unknown>) {
    return {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: {
        modelMap: { cheap: "model-cheap", mid: "model-mid", strong: "model-strong" },
        provider: "minimax",
        ...overrides,
      },
    } as ReturnType<typeof getProjectConfig>
  }

  it("does nothing when neither provider nor model specified", () => {
    const config = makeConfig()
    applyModelOverrides(config, undefined, undefined)
    expect(config.agent.default).toBeUndefined()
    expect(config.agent.modelMap.mid).toBe("model-mid")
  })

  it("overrides model for all tiers and sets default", () => {
    const config = makeConfig()
    applyModelOverrides(config, undefined, "gpt-4o")
    expect(config.agent.default).toEqual({ provider: "minimax", model: "gpt-4o" })
    expect(config.agent.modelMap.cheap).toBe("gpt-4o")
    expect(config.agent.modelMap.mid).toBe("gpt-4o")
    expect(config.agent.modelMap.strong).toBe("gpt-4o")
  })

  it("overrides provider and sets default", () => {
    const config = makeConfig()
    applyModelOverrides(config, "anthropic", undefined)
    expect(config.agent.default?.provider).toBe("anthropic")
    expect(config.agent.provider).toBe("anthropic")
    // model falls back to mid tier
    expect(config.agent.default?.model).toBe("model-mid")
    // modelMap tiers unchanged since only provider was overridden
    expect(config.agent.modelMap.cheap).toBe("model-cheap")
  })

  it("overrides both provider and model", () => {
    const config = makeConfig()
    applyModelOverrides(config, "anthropic", "claude-sonnet-4-6")
    expect(config.agent.default).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" })
    expect(config.agent.provider).toBe("anthropic")
    expect(config.agent.modelMap.mid).toBe("claude-sonnet-4-6")
  })

  it("clears per-stage overrides so CLI flag applies uniformly", () => {
    const config = makeConfig({
      stages: {
        build: { provider: "openai", model: "gpt-4o" },
        review: { provider: "google", model: "gemini-2.5-flash" },
      },
    })
    applyModelOverrides(config, "anthropic", "claude-sonnet-4-6")
    expect(config.agent.stages).toBeUndefined()
    // resolveStageConfig should now return the override for any stage
    const buildConfig = resolveStageConfig(config, "build", "mid")
    expect(buildConfig.provider).toBe("anthropic")
    expect(buildConfig.model).toBe("claude-sonnet-4-6")
    const reviewConfig = resolveStageConfig(config, "review", "strong")
    expect(reviewConfig.provider).toBe("anthropic")
    expect(reviewConfig.model).toBe("claude-sonnet-4-6")
  })

  it("preserves existing default when only model is overridden", () => {
    const config = makeConfig({
      default: { provider: "google", model: "gemini-2.5-flash" },
    })
    applyModelOverrides(config, undefined, "gpt-4o")
    expect(config.agent.default?.provider).toBe("google")
    expect(config.agent.default?.model).toBe("gpt-4o")
  })
})
