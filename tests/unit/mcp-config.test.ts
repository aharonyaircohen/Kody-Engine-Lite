import { describe, it, expect } from "vitest"
import { buildMcpConfigJson, isMcpEnabledForStage, withPlaywrightIfNeeded } from "../../src/mcp-config.js"
import type { McpConfig } from "../../src/config.js"

describe("buildMcpConfigJson", () => {
  it("returns undefined when mcp config is undefined", () => {
    expect(buildMcpConfigJson(undefined)).toBeUndefined()
  })

  it("returns undefined when mcp is disabled", () => {
    const mcp: McpConfig = {
      enabled: false,
      servers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
    }
    expect(buildMcpConfigJson(mcp)).toBeUndefined()
  })

  it("returns undefined when no servers configured", () => {
    const mcp: McpConfig = { enabled: true, servers: {} }
    expect(buildMcpConfigJson(mcp)).toBeUndefined()
  })

  it("returns valid JSON with one server", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
    }
    const json = buildMcpConfigJson(mcp)
    expect(json).toBeDefined()
    const parsed = JSON.parse(json!)
    expect(parsed.mcpServers.playwright).toEqual({
      command: "npx",
      args: ["@playwright/mcp@latest"],
    })
  })

  it("returns valid JSON with multiple servers", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    }
    const json = buildMcpConfigJson(mcp)
    const parsed = JSON.parse(json!)
    expect(Object.keys(parsed.mcpServers)).toHaveLength(2)
    expect(parsed.mcpServers.playwright.command).toBe("npx")
    expect(parsed.mcpServers.github.command).toBe("npx")
  })

  it("includes env when provided", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "tok_123" },
        },
      },
    }
    const json = buildMcpConfigJson(mcp)
    const parsed = JSON.parse(json!)
    expect(parsed.mcpServers.github.env).toEqual({ GITHUB_TOKEN: "tok_123" })
  })

  it("omits env when not provided", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
    }
    const json = buildMcpConfigJson(mcp)
    const parsed = JSON.parse(json!)
    expect(parsed.mcpServers.playwright.env).toBeUndefined()
  })

  it("defaults args to empty array when not provided", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: {
        myserver: { command: "/usr/bin/my-mcp-server" },
      },
    }
    const json = buildMcpConfigJson(mcp)
    const parsed = JSON.parse(json!)
    expect(parsed.mcpServers.myserver.args).toEqual([])
  })
})

describe("isMcpEnabledForStage", () => {
  it("returns false when mcp config is undefined", () => {
    expect(isMcpEnabledForStage("build", undefined)).toBe(false)
  })

  it("returns false when mcp is disabled", () => {
    const mcp: McpConfig = {
      enabled: false,
      servers: { playwright: { command: "npx" } },
    }
    expect(isMcpEnabledForStage("build", mcp)).toBe(false)
  })

  it("returns false when enabled but no servers configured", () => {
    const mcp: McpConfig = { enabled: true, servers: {} }
    expect(isMcpEnabledForStage("build", mcp)).toBe(false)
  })

  it("uses default stages when stages not specified", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: { playwright: { command: "npx" } },
    }
    expect(isMcpEnabledForStage("build", mcp)).toBe(true)
    expect(isMcpEnabledForStage("verify", mcp)).toBe(true)
    expect(isMcpEnabledForStage("review", mcp)).toBe(true)
    expect(isMcpEnabledForStage("review-fix", mcp)).toBe(true)
  })

  it("excludes stages not in default list", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: { playwright: { command: "npx" } },
    }
    expect(isMcpEnabledForStage("taskify", mcp)).toBe(false)
    expect(isMcpEnabledForStage("plan", mcp)).toBe(false)
    expect(isMcpEnabledForStage("ship", mcp)).toBe(false)
  })

  it("respects custom stages list", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: { playwright: { command: "npx" } },
      stages: ["build"],
    }
    expect(isMcpEnabledForStage("build", mcp)).toBe(true)
    expect(isMcpEnabledForStage("review", mcp)).toBe(false)
    expect(isMcpEnabledForStage("verify", mcp)).toBe(false)
  })
})

describe("withPlaywrightIfNeeded", () => {
  it("returns undefined when mcp config is undefined", () => {
    expect(withPlaywrightIfNeeded(undefined, true)).toBeUndefined()
  })

  it("returns unchanged config when disabled", () => {
    const mcp: McpConfig = { enabled: false, servers: {} }
    expect(withPlaywrightIfNeeded(mcp, true)).toBe(mcp)
  })

  it("returns unchanged config when hasUI is false", () => {
    const mcp: McpConfig = { enabled: true, servers: {} }
    expect(withPlaywrightIfNeeded(mcp, false)).toBe(mcp)
  })

  it("injects playwright server when hasUI and no playwright configured", () => {
    const mcp: McpConfig = { enabled: true, servers: {} }
    const result = withPlaywrightIfNeeded(mcp, true)!
    expect(result.servers.playwright).toBeDefined()
    expect(result.servers.playwright.command).toBe("npx")
    expect(result.servers.playwright.args).toContain("@anthropic-ai/mcp-playwright")
  })

  it("does not mutate original config", () => {
    const mcp: McpConfig = { enabled: true, servers: {} }
    withPlaywrightIfNeeded(mcp, true)
    expect(Object.keys(mcp.servers)).toHaveLength(0)
  })

  it("skips injection when playwright already configured", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
    }
    const result = withPlaywrightIfNeeded(mcp, true)
    expect(result).toBe(mcp)
  })

  it("skips injection when server name contains playwright", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: { "my-playwright-server": { command: "node", args: ["server.js"] } },
    }
    const result = withPlaywrightIfNeeded(mcp, true)
    expect(result).toBe(mcp)
  })

  it("preserves existing servers when injecting", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: { github: { command: "npx", args: ["-y", "mcp-github"] } },
    }
    const result = withPlaywrightIfNeeded(mcp, true)!
    expect(result.servers.github).toEqual(mcp.servers.github)
    expect(result.servers.playwright).toBeDefined()
  })
})
