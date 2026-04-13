import { describe, it, expect } from "vitest"
import { buildMcpConfigJson, isMcpEnabledForStage, resolveMcpServers } from "../../src/mcp-config.js"
import type { McpConfig } from "../../src/config.js"

describe("resolveMcpServers", () => {
  it("resolves a registry name string to a full server config", () => {
    const servers = { github: "github" }
    const resolved = resolveMcpServers(servers)
    expect(resolved.github).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
    })
  })

  it("resolves multiple registry names", () => {
    const servers = { github: "github", playwright: "playwright" }
    const resolved = resolveMcpServers(servers)
    expect(resolved.github.command).toBe("npx")
    expect(resolved.playwright.command).toBe("npx")
    expect(resolved.playwright.args).toContain("@anthropic-ai/mcp-playwright")
  })

  it("preserves inline config objects as-is", () => {
    const servers = {
      github: { command: "node", args: ["server.js"] },
    }
    const resolved = resolveMcpServers(servers)
    expect(resolved.github).toEqual({ command: "node", args: ["server.js"] })
  })

  it("mixes registry names and inline configs", () => {
    const servers = {
      github: "github",
      custom: { command: "node", args: ["custom.js"] },
    }
    const resolved = resolveMcpServers(servers)
    expect(resolved.github.command).toBe("npx")
    expect(resolved.custom).toEqual({ command: "node", args: ["custom.js"] })
  })

  it("inline config can override a registry entry", () => {
    const servers = {
      github: {
        command: "npx",
        args: ["-y", "@custom/server-github", "--extra-flag"],
      },
    }
    const resolved = resolveMcpServers(servers)
    expect(resolved.github.args).toEqual(["-y", "@custom/server-github", "--extra-flag"])
    // env should not be inherited from registry when using inline config
    expect(resolved.github.env).toBeUndefined()
  })

  it("throws on unknown registry name", () => {
    const servers = { unknown: "not-a-real-server" as string }
    expect(() => resolveMcpServers(servers)).toThrow(/Unknown MCP server registry entry: "not-a-real-server"/)
  })

  it("throws with available registry names in error message", () => {
    const servers = { foo: "does-not-exist" as string }
    expect(() => resolveMcpServers(servers)).toThrow(/github/)
    expect(() => resolveMcpServers(servers)).toThrow(/playwright/)
    expect(() => resolveMcpServers(servers)).toThrow(/filesystem/)
  })

  it("server name key can differ from registry entry name", () => {
    const servers = { mygh: "github" }
    const resolved = resolveMcpServers(servers)
    expect(resolved.mygh).toBeDefined()
    expect(resolved.mygh.command).toBe("npx")
    expect(resolved.mygh.args).toContain("@modelcontextprotocol/server-github")
  })
})

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

  it("returns valid JSON with inline server config", () => {
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

  it("returns valid JSON with registry reference", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: { github: "github" },
    }
    const json = buildMcpConfigJson(mcp)
    const parsed = JSON.parse(json!)
    expect(parsed.mcpServers.github).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
    })
  })

  it("mixes registry references and inline configs in JSON output", () => {
    const mcp: McpConfig = {
      enabled: true,
      servers: {
        github: "github",
        playwright: { command: "npx", args: ["-y", "@custom/playwright"] },
      },
    }
    const json = buildMcpConfigJson(mcp)
    const parsed = JSON.parse(json!)
    expect(Object.keys(parsed.mcpServers)).toHaveLength(2)
    expect(parsed.mcpServers.github.args).toContain("@modelcontextprotocol/server-github")
    expect(parsed.mcpServers.playwright.args).toContain("@custom/playwright")
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
