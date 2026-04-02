import { describe, it, expect } from "vitest"
import { generateLitellmConfig, generateLitellmConfigFromStages } from "../../src/cli/litellm.js"

describe("generateLitellmConfig", () => {
  it("generates valid YAML for minimax provider", () => {
    const yaml = generateLitellmConfig("minimax", {
      cheap: "MiniMax-M2.7-highspeed",
      mid: "MiniMax-M2.7-highspeed",
      strong: "MiniMax-M2.7-highspeed",
    })

    expect(yaml).toContain("model_list:")
    expect(yaml).toContain("model: minimax/MiniMax-M2.7-highspeed")
    // providerApiKeyEnvVar returns MINIMAX_API_KEY if set in env, else ANTHROPIC_COMPATIBLE_API_KEY
    expect(yaml).toMatch(/api_key: os\.environ\/(MINIMAX_API_KEY|ANTHROPIC_COMPATIBLE_API_KEY)/)
    // Config model name is the single source of truth
    expect(yaml).toContain("model_name: MiniMax-M2.7-highspeed")
    // Deduped: same model across all tiers → single entry
    const matches = yaml.match(/model_name:/g)
    expect(matches).toHaveLength(1)
  })

  it("generates correct config for openai provider", () => {
    const yaml = generateLitellmConfig("openai", {
      cheap: "gpt-4o-mini",
      mid: "gpt-4o",
      strong: "o3",
    })

    expect(yaml).toContain("model_name: gpt-4o-mini")
    expect(yaml).toContain("model: openai/gpt-4o-mini")
    expect(yaml).toContain("model_name: gpt-4o")
    expect(yaml).toContain("model: openai/gpt-4o")
    expect(yaml).toContain("model_name: o3")
    expect(yaml).toContain("model: openai/o3")
    // providerApiKeyEnvVar returns OPENAI_API_KEY if set in env, else ANTHROPIC_COMPATIBLE_API_KEY
    expect(yaml).toMatch(/api_key: os\.environ\/(OPENAI_API_KEY|ANTHROPIC_COMPATIBLE_API_KEY)/)
  })

  it("deduplicates when multiple tiers use the same model", () => {
    const yaml = generateLitellmConfig("google", {
      cheap: "gemini-2.0-flash",
      mid: "gemini-2.5-pro",
      strong: "gemini-2.5-pro",
    })

    // Two unique models, not three
    expect(yaml).toContain("model_name: gemini-2.0-flash")
    expect(yaml).toContain("model: google/gemini-2.0-flash")
    expect(yaml).toContain("model_name: gemini-2.5-pro")
    expect(yaml).toContain("model: google/gemini-2.5-pro")
    const matches = yaml.match(/model_name:/g)
    expect(matches).toHaveLength(2)
  })

  it("adds drop_params for non-Anthropic providers", () => {
    const yaml = generateLitellmConfig("gemini", {
      cheap: "gemini-2.5-flash",
      mid: "gemini-2.5-flash",
      strong: "gemini-2.5-flash",
    })

    expect(yaml).toContain("litellm_settings:")
    expect(yaml).toContain("drop_params: true")
  })

  it("adds drop_params for openai provider", () => {
    const yaml = generateLitellmConfig("openai", {
      cheap: "gpt-4o-mini",
      mid: "gpt-4o",
      strong: "o3",
    })

    expect(yaml).toContain("litellm_settings:")
    expect(yaml).toContain("drop_params: true")
  })

  it("does not add drop_params for anthropic provider", () => {
    const yaml = generateLitellmConfig("anthropic", {
      cheap: "claude-haiku-4-5-20251001",
      mid: "claude-sonnet-4-6-20260320",
      strong: "claude-sonnet-4-6-20260320",
    })

    expect(yaml).not.toContain("drop_params")
  })

  it("does not add drop_params for claude provider", () => {
    const yaml = generateLitellmConfig("claude", {
      cheap: "claude-haiku-4-5-20251001",
      mid: "claude-sonnet-4-6-20260320",
      strong: "claude-sonnet-4-6-20260320",
    })

    expect(yaml).not.toContain("drop_params")
  })
})

describe("generateLitellmConfigFromStages", () => {
  it("returns undefined when all providers are claude/anthropic", () => {
    const result = generateLitellmConfigFromStages(
      { provider: "claude", model: "claude-sonnet-4-6-20260320" },
      undefined,
    )
    expect(result).toBeUndefined()
  })

  it("generates config with drop_params for non-Anthropic default provider", () => {
    const yaml = generateLitellmConfigFromStages(
      { provider: "gemini", model: "gemini-2.5-flash" },
      undefined,
    )

    expect(yaml).toBeDefined()
    expect(yaml).toContain("model_name: gemini-2.5-flash")
    expect(yaml).toContain("litellm_settings:")
    expect(yaml).toContain("drop_params: true")
  })

  it("generates config with drop_params when stages have non-Anthropic providers", () => {
    const yaml = generateLitellmConfigFromStages(
      undefined,
      {
        build: { provider: "gemini", model: "gemini-2.5-flash" },
        verify: { provider: "gemini", model: "gemini-2.5-flash" },
      },
    )

    expect(yaml).toBeDefined()
    expect(yaml).toContain("drop_params: true")
  })
})
