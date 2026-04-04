import type { McpConfig, KodyConfig } from "./config.js"

const DEFAULT_MCP_STAGES = ["build", "verify", "review", "review-fix"]

const PLAYWRIGHT_SERVER: { command: string; args: string[] } = {
  command: "npx",
  args: ["-y", "@anthropic-ai/mcp-playwright"],
}

/**
 * Ensure the Playwright MCP server is present when a UI task needs it.
 * Returns a new McpConfig with the server injected (never mutates).
 */
export function withPlaywrightIfNeeded(
  mcpConfig: McpConfig | undefined,
  hasUI: boolean,
): McpConfig | undefined {
  if (!mcpConfig?.enabled || !hasUI) return mcpConfig

  // Already has a playwright server configured
  const hasPlaywright = Object.keys(mcpConfig.servers).some(
    (name) => name.toLowerCase().includes("playwright"),
  )
  if (hasPlaywright) return mcpConfig

  return {
    ...mcpConfig,
    servers: {
      ...mcpConfig.servers,
      playwright: PLAYWRIGHT_SERVER,
    },
  }
}

/**
 * Build the Claude Code MCP config JSON string for --mcp-config.
 * Returns undefined if MCP is disabled or no servers configured.
 */
export function buildMcpConfigJson(mcpConfig: McpConfig | undefined): string | undefined {
  if (!mcpConfig?.enabled) return undefined
  if (Object.keys(mcpConfig.servers).length === 0) return undefined

  const config: Record<string, unknown> = { mcpServers: {} }
  const mcpServers = config.mcpServers as Record<string, unknown>

  for (const [name, server] of Object.entries(mcpConfig.servers)) {
    mcpServers[name] = {
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    }
  }
  return JSON.stringify(config)
}

import type { McpServerConfig } from "./config.js"

/**
 * Resolve `${VAR}` placeholders in MCP server env values using process.env.
 * Throws if a referenced variable is not set.
 */
export function resolveMcpEnvVars(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const resolved: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(servers)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(server.env ?? {})) {
      env[k] = v.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
        const val = process.env[varName]
        if (!val) {
          throw new Error(
            `MCP env var \$\{${varName}\} is not set (required by MCP server '${name}'). ` +
            `Add it as a GitHub secret and it will be forwarded automatically.`,
          )
        }
        return val
      })
    }
    resolved[name] = { ...server, ...(Object.keys(env).length > 0 ? { env } : {}) }
  }
  return resolved
}

/**
 * Build the MCP config JSON string for the `kody taskify` command.
 * Uses only the servers defined in config.mcp.servers — no defaults injected.
 * Resolves all ${VAR} env placeholders — throws if any are missing.
 * Throws if no MCP servers are configured (taskify requires at least one to fetch the ticket).
 */
export function buildTaskifyMcpConfigJson(config: KodyConfig): string {
  const servers = config.mcp?.servers ?? {}
  if (Object.keys(servers).length === 0) {
    throw new Error(
      "kody taskify requires at least one MCP server configured in kody.config.json under mcp.servers. " +
      "Add your task management tool's MCP server there.",
    )
  }
  const resolvedServers = resolveMcpEnvVars(servers)
  const mcpServers: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(resolvedServers)) {
    mcpServers[name] = {
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    }
  }
  return JSON.stringify({ mcpServers })
}

/**
 * Check if a given stage should have MCP tools available.
 * Returns false if MCP is disabled.
 */
export function isMcpEnabledForStage(
  stageName: string,
  mcpConfig: McpConfig | undefined,
): boolean {
  if (!mcpConfig?.enabled) return false
  // No actual MCP servers configured — nothing to load
  if (!mcpConfig.servers || Object.keys(mcpConfig.servers).length === 0) return false
  const allowedStages = mcpConfig.stages ?? DEFAULT_MCP_STAGES
  return allowedStages.includes(stageName)
}
