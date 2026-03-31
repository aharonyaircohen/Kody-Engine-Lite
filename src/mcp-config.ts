import type { McpConfig } from "./config.js"

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

/**
 * Check if a given stage should have MCP tools available.
 * Returns false if MCP is disabled.
 */
export function isMcpEnabledForStage(
  stageName: string,
  mcpConfig: McpConfig | undefined,
): boolean {
  if (!mcpConfig?.enabled) return false
  const allowedStages = mcpConfig.stages ?? DEFAULT_MCP_STAGES
  return allowedStages.includes(stageName)
}
