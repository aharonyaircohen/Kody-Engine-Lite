import type { McpConfig } from "./config.js"

const DEFAULT_MCP_STAGES = ["build", "verify", "review", "review-fix"]

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
 * Returns false if MCP is disabled or has no servers.
 */
export function isMcpEnabledForStage(
  stageName: string,
  mcpConfig: McpConfig | undefined,
): boolean {
  if (!mcpConfig?.enabled) return false
  if (Object.keys(mcpConfig.servers).length === 0) return false
  const allowedStages = mcpConfig.stages ?? DEFAULT_MCP_STAGES
  return allowedStages.includes(stageName)
}
