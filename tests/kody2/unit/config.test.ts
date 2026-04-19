import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  loadConfig,
  parseProviderModel,
  needsLitellmProxy,
  providerApiKeyEnvVar,
} from "../../../src-v2/config.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody2-test-"))
}

function writeConfig(dir: string, contents: unknown): void {
  fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify(contents))
}

describe("config: parseProviderModel", () => {
  it("parses 'provider/model' correctly", () => {
    expect(parseProviderModel("minimax/MiniMax-M2.7-highspeed")).toEqual({
      provider: "minimax",
      model: "MiniMax-M2.7-highspeed",
    })
  })

  it("throws on missing slash", () => {
    expect(() => parseProviderModel("badmodel")).toThrow(/Invalid model spec/)
  })

  it("throws on trailing slash", () => {
    expect(() => parseProviderModel("provider/")).toThrow(/Invalid model spec/)
  })

  it("preserves slashes inside model name", () => {
    expect(parseProviderModel("a/b/c")).toEqual({ provider: "a", model: "b/c" })
  })
})

describe("config: needsLitellmProxy / providerApiKeyEnvVar", () => {
  it("anthropic providers do not need proxy", () => {
    expect(needsLitellmProxy({ provider: "claude", model: "x" })).toBe(false)
    expect(needsLitellmProxy({ provider: "anthropic", model: "x" })).toBe(false)
  })

  it("other providers need proxy", () => {
    expect(needsLitellmProxy({ provider: "minimax", model: "x" })).toBe(true)
  })

  it("derives env var name correctly", () => {
    expect(providerApiKeyEnvVar("claude")).toBe("ANTHROPIC_API_KEY")
    expect(providerApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY")
    expect(providerApiKeyEnvVar("minimax")).toBe("MINIMAX_API_KEY")
    expect(providerApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY")
  })
})

describe("config: loadConfig", () => {
  it("loads minimal valid config", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "minimax/m" },
    })
    const cfg = loadConfig(dir)
    expect(cfg.github.owner).toBe("o")
    expect(cfg.agent.model).toBe("minimax/m")
    expect(cfg.git.defaultBranch).toBe("main")
  })

  it("throws when kody.config.json missing", () => {
    const dir = tmpDir()
    expect(() => loadConfig(dir)).toThrow(/not found/)
  })

  it("throws on malformed JSON", () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "kody.config.json"), "{not json")
    expect(() => loadConfig(dir)).toThrow(/invalid JSON/)
  })

  it("throws when agent.model missing", () => {
    const dir = tmpDir()
    writeConfig(dir, { github: { owner: "o", repo: "r" }, agent: {} })
    expect(() => loadConfig(dir)).toThrow(/agent\.model/)
  })

  it("throws when github.owner missing", () => {
    const dir = tmpDir()
    writeConfig(dir, { github: { repo: "r" }, agent: { model: "m/x" } })
    expect(() => loadConfig(dir)).toThrow(/github\.owner/)
  })

  it("preserves quality commands", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      quality: { typecheck: "tc", testUnit: "tu", lint: "ln" },
    })
    const cfg = loadConfig(dir)
    expect(cfg.quality).toEqual({ typecheck: "tc", testUnit: "tu", lint: "ln" })
  })
})
