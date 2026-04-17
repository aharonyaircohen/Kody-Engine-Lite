import { describe, it, expect } from "vitest"
import { generateLitellmConfigFromStages, collectConfiguredModels } from "../../src/cli/litellm.js"

describe("generateLitellmConfigFromStages", () => {
  it("returns undefined when every entry is claude/anthropic", () => {
    const result = generateLitellmConfigFromStages([
      { provider: "claude", model: "claude-sonnet-4-6" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ])
    expect(result).toBeUndefined()
  })

  it("emits a model_list with provider/model and api_key for non-claude providers", () => {
    const yaml = generateLitellmConfigFromStages([
      { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
    ])
    expect(yaml).toBeDefined()
    expect(yaml).toContain("model_list:")
    expect(yaml).toContain("model_name: MiniMax-M2.7-highspeed")
    expect(yaml).toContain("model: minimax/MiniMax-M2.7-highspeed")
    expect(yaml).toContain("api_key: os.environ/MINIMAX_API_KEY")
  })

  it("deduplicates identical provider+model entries", () => {
    const yaml = generateLitellmConfigFromStages([
      { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
      { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
      { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
    ])
    expect(yaml).toBeDefined()
    expect(yaml!.match(/model_name:/g)).toHaveLength(1)
  })

  it("emits multiple entries for distinct models", () => {
    const yaml = generateLitellmConfigFromStages([
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "o3" },
    ])
    expect(yaml).toBeDefined()
    expect(yaml!.match(/model_name:/g)).toHaveLength(3)
    expect(yaml).toContain("model: openai/gpt-4o-mini")
    expect(yaml).toContain("model: openai/gpt-4o")
    expect(yaml).toContain("model: openai/o3")
    expect(yaml).toContain("api_key: os.environ/OPENAI_API_KEY")
  })

  it("filters out claude/anthropic and only includes proxy-bound entries", () => {
    const yaml = generateLitellmConfigFromStages([
      { provider: "claude", model: "claude-sonnet-4-6" },
      { provider: "minimax", model: "MiniMax-M1" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ])
    expect(yaml).toBeDefined()
    expect(yaml!.match(/model_name:/g)).toHaveLength(1)
    expect(yaml).toContain("model: minimax/MiniMax-M1")
    expect(yaml).not.toContain("claude-sonnet-4-6")
    expect(yaml).not.toContain("claude-haiku-4-5")
  })

  it("appends drop_params: true when proxy-bound entries are present", () => {
    const yaml = generateLitellmConfigFromStages([
      { provider: "google", model: "gemini-2.5-flash" },
    ])
    expect(yaml).toContain("litellm_settings:")
    expect(yaml).toContain("drop_params: true")
  })
})

describe("collectConfiguredModels", () => {
  function cfg(agent: Record<string, unknown>): Parameters<typeof collectConfiguredModels>[0] {
    return {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: agent as Parameters<typeof collectConfiguredModels>[0]["agent"],
    }
  }

  it("collects modelMap, default, and stages entries", () => {
    const out = collectConfiguredModels(cfg({
      modelMap: { cheap: "claude/claude-haiku-4-5", mid: "minimax/MiniMax-M1" },
      default: "openai/gpt-4o",
      stages: { plan: "google/gemini-2.5-flash" },
    }))
    expect(out).toEqual([
      { provider: "claude", model: "claude-haiku-4-5" },
      { provider: "minimax", model: "MiniMax-M1" },
      { provider: "openai", model: "gpt-4o" },
      { provider: "google", model: "gemini-2.5-flash" },
    ])
  })

  it("returns empty for empty config", () => {
    expect(collectConfiguredModels(cfg({ modelMap: {} }))).toEqual([])
  })

  it("throws on malformed entry", () => {
    expect(() => collectConfiguredModels(cfg({ modelMap: { cheap: "no-slash" } }))).toThrow(/expected 'provider\/model'/)
  })
})
