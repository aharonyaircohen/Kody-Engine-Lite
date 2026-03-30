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
    // Should map all Anthropic model IDs
    expect(yaml).toContain("model_name: claude-sonnet-4-6")
    expect(yaml).toContain("model_name: claude-haiku-4-5")
    expect(yaml).toContain("model_name: claude-opus-4-6")
    // Should also map short Anthropic names
    expect(yaml).toContain("model_name: haiku")
    expect(yaml).toContain("model_name: sonnet")
    expect(yaml).toContain("model_name: opus")
  })

  it("generates correct config for openai provider", () => {
    const yaml = generateLitellmConfig("openai", {
      cheap: "gpt-4o-mini",
      mid: "gpt-4o",
      strong: "o3",
    })

    expect(yaml).toContain("model: openai/gpt-4o-mini")
    expect(yaml).toContain("model: openai/gpt-4o")
    expect(yaml).toContain("model: openai/o3")
    expect(yaml).toContain("api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY")
  })

  it("maps different models per tier", () => {
    const yaml = generateLitellmConfig("google", {
      cheap: "gemini-2.0-flash",
      mid: "gemini-2.5-pro",
      strong: "gemini-2.5-pro",
    })

    // Haiku IDs should map to cheap model
    expect(yaml).toContain("model_name: claude-haiku-4-5")
    expect(yaml).toContain("model: google/gemini-2.0-flash")
    // Sonnet IDs should map to mid model
    expect(yaml).toContain("model: google/gemini-2.5-pro")
    expect(yaml).toContain("api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY")
  })
})
