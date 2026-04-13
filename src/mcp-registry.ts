/**
 * Curated registry of popular MCP servers.
 *
 * Users reference servers by name in kody.config.json instead of copy-pasting commands:
 *
 *   "mcp": {
 *     "servers": {
 *       "github": "github",       // ← references registry entry
 *       "my-server": {             // ← or inline config for custom/unregistered servers
 *         "command": "node",
 *         "args": ["/path/to/server.js"]
 *       }
 *     }
 *   }
 *
 * Env vars in registry entries use ${VAR} syntax and are resolved at runtime from process.env.
 * See resolveMcpEnvVars() in mcp-config.ts.
 */

export interface RegistryEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
  description: string
}

export const MCPServerRegistry: Record<string, RegistryEntry> = {
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
    description: "GitHub API — issues, PRs, repos, reviews",
  },

  playwright: {
    command: "npx",
    args: ["-y", "@anthropic-ai/mcp-playwright"],
    description: "Browser automation via Playwright",
  },

  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "./"],
    description: "File system access via MCP",
  },

  slack: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}" },
    description: "Slack messaging and workspace access",
  },

  brave_search: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
    description: "Web search via Brave Search API",
  },

  sqlite: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", "./data.db"],
    description: "SQLite database access",
  },
}
