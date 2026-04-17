import { describe, it, expect } from "vitest"
import { createClaudeCodeRunner, createRunners } from "../../src/agent-runner.js"
import type { KodyConfig } from "../../src/config.js"

describe("createClaudeCodeRunner", () => {
  it("returns an object with run and healthCheck", () => {
    const runner = createClaudeCodeRunner()
    expect(runner).toHaveProperty("run")
    expect(runner).toHaveProperty("healthCheck")
    expect(typeof runner.run).toBe("function")
    expect(typeof runner.healthCheck).toBe("function")
  })
})

describe("createRunners", () => {
  const baseConfig: KodyConfig = {
    quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "", repo: "" },
    agent: {
      modelMap: { cheap: "haiku", mid: "sonnet", strong: "opus" },
    },
  }

  it("creates default sdk runner when no runners config", () => {
    const runners = createRunners(baseConfig)
    expect(runners).toHaveProperty("sdk")
    expect(typeof runners.sdk.run).toBe("function")
  })

  it("honours explicit defaultRunner: \"claude-code\" for opt-in subprocess", () => {
    const runners = createRunners({
      ...baseConfig,
      agent: { ...baseConfig.agent, defaultRunner: "claude-code" },
    })
    expect(runners).toHaveProperty("claude-code")
    expect(typeof runners["claude-code"].run).toBe("function")
  })

  it("routes legacy defaultRunner: \"claude\" to the SDK runner (migration alias)", () => {
    const runners = createRunners({
      ...baseConfig,
      agent: { ...baseConfig.agent, defaultRunner: "claude" },
    })
    // Key preserves the legacy name; factory silently upgraded to SDK.
    expect(runners).toHaveProperty("claude")
    expect(typeof runners.claude.run).toBe("function")
  })

  it("creates runners from config", () => {
    const config: KodyConfig = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        runners: {
          claude: { type: "claude-code" },
          backup: { type: "claude-code" },
        },
      },
    }
    const runners = createRunners(config)
    expect(runners).toHaveProperty("claude")
    expect(runners).toHaveProperty("backup")
  })

  it("ignores unknown runner types", () => {
    const config: KodyConfig = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        runners: {
          claude: { type: "claude-code" },
          unknown: { type: "nonexistent" as "claude-code" },
        },
      },
    }
    const runners = createRunners(config)
    expect(runners).toHaveProperty("claude")
    expect(runners).not.toHaveProperty("unknown")
  })
})
