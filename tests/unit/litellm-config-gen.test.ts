import { describe, it, expect } from "vitest"
import { generateLitellmConfig } from "../../src/cli/litellm.js"

describe("generateLitellmConfig", () => {
  it("generates valid YAML for minimax provider", () => {
    const yaml = generateLitellmConfig("minimax", {
      cheap: "MiniMax-M2.7-highspeed",
      mid: "MiniMax-M2.7-highspeed",
      strong: "MiniMax-M2.7-highspeed",
    })

    expect(yaml).toContain("model_list:")
    expect(yaml).toContain("model: minimax/MiniMax-M2.7-highspeed")
    expect(yaml).toContain("api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY")
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
    expect(yaml).toContain("api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY")
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
})
