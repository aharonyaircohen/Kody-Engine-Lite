import { describe, it, expect } from "vitest"
import { generateLitellmConfigYaml } from "../../../src-v2/litellm.js"

describe("litellm: generateLitellmConfigYaml", () => {
  it("emits a model_list with provider/model and api_key env var", () => {
    const yaml = generateLitellmConfigYaml({ provider: "minimax", model: "MiniMax-M2.7-highspeed" })
    expect(yaml).toMatch(/model_list:/)
    expect(yaml).toMatch(/model_name: MiniMax-M2\.7-highspeed/)
    expect(yaml).toMatch(/model: minimax\/MiniMax-M2\.7-highspeed/)
    expect(yaml).toMatch(/api_key: os\.environ\/MINIMAX_API_KEY/)
  })

  it("includes drop_params: true to silence non-anthropic warnings", () => {
    const yaml = generateLitellmConfigYaml({ provider: "openai", model: "gpt-4o" })
    expect(yaml).toMatch(/drop_params: true/)
  })

  it("derives api_key env var from provider name", () => {
    const yaml = generateLitellmConfigYaml({ provider: "openai", model: "gpt-4o" })
    expect(yaml).toMatch(/api_key: os\.environ\/OPENAI_API_KEY/)
  })
})
