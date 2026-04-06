/**
 * Universal sub-agents available during build and review-fix stages.
 *
 * Inspired by OMC agent patterns: explore, test-engineer, security-reviewer, debugger.
 * Each sub-agent gets a fresh context window and dedicated model.
 *
 * Folder-scoped sub-agents are loaded from .kody/sub-agents.yml and merged
 * with universal agents. Folder agents handle implementation within their scope,
 * while universal agents handle cross-cutting concerns.
 */

import * as fs from "fs"
import * as path from "path"
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk"

// Cached folder agents
let _cachedFolderAgents: Record<string, AgentDefinition> | null = null
let _cachedProjectDir: string | null = null

interface SubAgentYamlEntry {
  name: string
  scope: string
  model: "haiku" | "sonnet" | "opus"
  instructions: string
}

/** Parse a minimal YAML subset for sub-agents.yml */
function parseSubAgentsYaml(content: string): SubAgentYamlEntry[] {
  const configs: SubAgentYamlEntry[] = []
  const lines = content.split("\n")

  let currentEntry: Partial<SubAgentYamlEntry> | null = null
  let instructionsLines: string[] = []
  let inInstructions = false

  for (const line of lines) {
    // Skip comments and empty lines at top level
    if (line.trim() === "" || line.trim().startsWith("#")) continue

    // New agent definition (top-level key ending with colon)
    const agentMatch = line.match(/^([a-zA-Z0-9_-]+):\s*$/)
    if (agentMatch && !inInstructions) {
      if (currentEntry?.name && currentEntry.instructions) {
        configs.push(currentEntry as SubAgentYamlEntry)
      }
      currentEntry = { name: agentMatch[1], scope: "", model: "haiku", instructions: "" }
      instructionsLines = []
      continue
    }

    if (!currentEntry) continue

    // Scope
    const scopeMatch = line.match(/^\s+scope:\s*["']?([^"']+)["']?\s*$/)
    if (scopeMatch) {
      currentEntry.scope = scopeMatch[1]
      continue
    }

    // Model
    const modelMatch = line.match(/^\s+model:\s*(haiku|sonnet|opus)\s*$/)
    if (modelMatch) {
      currentEntry.model = modelMatch[1] as "haiku" | "sonnet" | "opus"
      continue
    }

    // Instructions block start
    const instructionsStartMatch = line.match(/^\s+instructions:\s*\|?\s*$/)
    if (instructionsStartMatch) {
      inInstructions = true
      instructionsLines = []
      continue
    }

    // Inside instructions block (indented content)
    if (inInstructions) {
      const indentMatch = line.match(/^(\s{4,})(.*)$/)
      if (indentMatch) {
        instructionsLines.push(indentMatch[2])
      } else if (line.trim() === "") {
        // Empty line within instructions
        instructionsLines.push("")
      } else {
        // End of instructions block (less indented or new key)
        inInstructions = false
        currentEntry.instructions = instructionsLines.join("\n").trim()
        // Check if this line starts a new key
        const newKeyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*$/)
        if (newKeyMatch) {
          // Process this line as a new agent
          if (currentEntry.name && currentEntry.instructions) {
            configs.push(currentEntry as SubAgentYamlEntry)
          }
          currentEntry = { name: newKeyMatch[1], scope: "", model: "haiku", instructions: "" }
          instructionsLines = []
          inInstructions = false
        }
      }
    }
  }

  // Final entry
  if (currentEntry?.name && currentEntry.instructions) {
    configs.push(currentEntry as SubAgentYamlEntry)
  }

  return configs
}

/** Load folder-scoped agents from .kody/sub-agents.yml */
function loadFolderAgents(projectDir: string): Record<string, AgentDefinition> {
  // Use cache if project dir hasn't changed
  if (_cachedFolderAgents && _cachedProjectDir === projectDir) {
    return _cachedFolderAgents
  }

  _cachedProjectDir = projectDir
  _cachedFolderAgents = {}

  const ymlPath = path.join(projectDir, ".kody", "sub-agents.yml")
  if (!fs.existsSync(ymlPath)) {
    return _cachedFolderAgents
  }

  try {
    const content = fs.readFileSync(ymlPath, "utf-8")
    const entries = parseSubAgentsYaml(content)

    for (const entry of entries) {
      _cachedFolderAgents[entry.name] = {
        description: `Folder agent for ${entry.scope} scope`,
        prompt: entry.instructions,
        model: entry.model,
        tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
        maxTurns: 15,
      }
    }
  } catch {
    // Ignore parse errors — return empty folder agents
  }

  return _cachedFolderAgents
}

/**
 * Build sub-agents for a given stage.
 * Returns undefined if the stage doesn't support sub-agents.
 *
 * Merges universal agents (researcher, test-writer, etc.) with
 * folder-scoped agents loaded from .kody/sub-agents.yml.
 */
export function buildSubAgents(stageName: string, projectDir?: string): Record<string, AgentDefinition> | undefined {
  if (stageName !== "build" && stageName !== "review-fix") {
    return undefined
  }

  const universalAgents: Record<string, AgentDefinition> = {
    researcher: {
      description: "Explore codebase to find patterns and understand structure",
      prompt: `You are a codebase researcher. Your role is to explore and understand code structure.

Guidelines:
- Use Read, Grep, and Glob to investigate the codebase
- Find patterns, dependencies, and architectural decisions
- Summarize your findings clearly for the calling agent
- Do NOT modify any files — this is a read-only investigation
- Return structured findings that help understand the code

When exploring:
1. Start with broad discovery (Glob, Grep) to understand structure
2. Drill into specific areas as needed (Read)
3. Identify patterns and relationships between components
4. Report back with clear, actionable insights`,
      model: "haiku",
      tools: ["Read", "Grep", "Glob"],
      maxTurns: 10,
    },

    "test-writer": {
      description: "Write and fix tests for changed code",
      prompt: `You are a test engineer. Your role is to write high-quality tests for code changes.

Guidelines:
- Use Read to understand the code being tested
- Write tests that are focused, readable, and maintainable
- Use Bash to run test commands and verify your tests pass
- Follow existing test patterns in the codebase
- Do NOT rewrite existing tests unless asked

When writing tests:
1. Understand what the code does from reading it
2. Identify edge cases and boundary conditions
3. Write test-first when possible (TDD approach)
4. Ensure tests are independent and can run in any order
5. Run the test suite to verify your changes don't break anything`,
      model: "haiku",
      tools: ["Read", "Write", "Bash", "Grep", "Glob"],
      maxTurns: 15,
    },

    "security-checker": {
      description: "Review code for security vulnerabilities (OWASP)",
      prompt: `You are a security reviewer. Your role is to identify potential security issues in code changes.

Guidelines:
- Use Read, Grep, and Glob to analyze the code
- Focus on OWASP Top 10 vulnerabilities and common security anti-patterns
- Check for: injection risks, auth issues, data exposure, secrets in code
- Do NOT modify any files — this is a read-only security audit
- Report findings with severity levels (Critical, Major, Minor)

Key areas to check:
1. Injection attacks (SQL, command, XSS)
2. Authentication and authorization bypass
3. Sensitive data exposure (secrets, credentials, PII)
4. Dependency vulnerabilities
5. Input validation and sanitization
6. Error handling that leaks implementation details

Report format:
- Finding description
- Affected files/lines
- Severity (Critical/Major/Minor)
- Recommended fix (conceptual, not code)`,
      model: "sonnet",
      tools: ["Read", "Grep", "Glob"],
      maxTurns: 10,
    },

    fixer: {
      description: "Fix specific bugs with minimal, targeted changes",
      prompt: `You are a bug fixer. Your role is to fix specific bugs with minimal diffs.

Guidelines:
- Use Read to understand the bug and surrounding context
- Use Edit for surgical changes — do NOT rewrite entire files
- Use Bash to verify the fix works
- Apply the 3-failure circuit breaker: if the same fix fails 3 times with different approaches, stop and report the blocker

Fix strategy:
1. Reproduce the bug — understand exactly what's wrong
2. Identify the root cause (not just the symptom)
3. Apply minimal fix
4. Verify the fix works
5. Ensure no regressions

Circuit breaker:
- Track attempts per bug
- After 3 failed attempts with different approaches, stop and report:
  * What you tried
  * Why each attempt failed
  * The blocker preventing a fix
- Move to next bug if any`,
      model: "sonnet",
      tools: ["Read", "Edit", "Bash", "Grep", "Glob"],
      maxTurns: 10,
    },
  }

  // Load and merge folder agents
  const folderAgents = projectDir ? loadFolderAgents(projectDir) : {}

  // Folder agents take precedence over universal agents with the same name
  // (though typically they have different names like "web-agent", "server-agent")
  return {
    ...universalAgents,
    ...folderAgents,
  }
}
