/**
 * Sub-agent generator for folder-scoped agents.
 *
 * Generates `.kody/sub-agents.yml` with per-folder agents containing
 * project-specific conventions, constraints, and patterns.
 */

import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import type { FolderScope, StructureDetection } from "./folder-scopes.js"
import { detectProjectStructure } from "./folder-scopes.js"

export interface SubAgentConfig {
  name: string
  scope: string
  model: "haiku" | "sonnet" | "opus"
  instructions: string
}

/** Model tier recommendation based on folder complexity */
function recommendModel(scope: FolderScope): "haiku" | "sonnet" | "opus" {
  // Server/backend folders get stronger models
  const backendKeywords = ["server", "api", "backend", "service", "core"]
  if (backendKeywords.some(k => scope.name.toLowerCase().includes(k))) {
    return "sonnet"
  }

  // Admin/panel folders
  const adminKeywords = ["admin", "panel", "dashboard", "cms"]
  if (adminKeywords.some(k => scope.name.toLowerCase().includes(k))) {
    return "haiku"
  }

  // Web/frontend folders
  const frontendKeywords = ["web", "frontend", "client", "ui", "app"]
  if (frontendKeywords.some(k => scope.name.toLowerCase().includes(k))) {
    return "haiku"
  }

  // Check dependencies for complexity hints
  const heavyDeps = ["prisma", "drizzle", "typeorm", "@nestjs", "express", "fastify"]
  if (scope.dependencies.some(d => heavyDeps.includes(d) || heavyDeps.some(h => d.startsWith(h)))) {
    return "sonnet"
  }

  return "haiku"
}

/** Generate instructions text for a folder scope */
function generateInstructions(scope: FolderScope): string {
  const lines: string[] = []

  // Header with framework info
  if (scope.framework) {
    lines.push(`${scope.framework.charAt(0).toUpperCase() + scope.framework.slice(1)} implementation.`)
  }

  if (scope.packageJson) {
    const pkgName = scope.packageJson.name as string | undefined
    if (pkgName) {
      lines.push(`Package: ${pkgName}`)
    }
  }

  lines.push("")

  // Conventions section
  if (scope.conventions.length > 0) {
    lines.push("Conventions:")
    for (const conv of scope.conventions) {
      lines.push(`- ${conv}`)
    }
    lines.push("")
  }

  // Export style
  if (scope.exportStyle === "named") {
    lines.push("- Named exports only (no export default)")
  } else if (scope.exportStyle === "default") {
    lines.push("- Default exports preferred")
  }

  // Import patterns
  const aliasImports = scope.importPatterns.filter(p => p.startsWith("alias:"))
  if (aliasImports.length > 0) {
    const aliases = aliasImports.slice(0, 3).map(p => p.replace("alias: ", ""))
    lines.push(`- Use absolute imports: ${aliases.join(", ")}`)
  }

  // Path aliases from tsconfig
  if (Object.keys(scope.pathAliases).length > 0) {
    lines.push("- Path aliases from tsconfig:")
    for (const [alias, target] of Object.entries(scope.pathAliases).slice(0, 5)) {
      lines.push(`  @${alias.replace("/*", "")} → ${target.replace("/*", "")}`)
    }
  }

  lines.push("")

  // Constraints section
  if (scope.constraints.length > 0) {
    lines.push("Constraints:")
    for (const constraint of scope.constraints) {
      lines.push(`- ${constraint}`)
    }
    lines.push("")
  }

  // Test framework
  if (scope.hasTests && scope.testFramework) {
    lines.push(`- Tests use ${scope.testFramework}`)
  }

  // File count hint
  if (scope.fileCount > 50) {
    lines.push("- Large module: consider splitting files >300 lines")
  }

  // Cross-folder isolation warning (for monorepos)
  lines.push("")
  lines.push("Isolation:")
  lines.push("- Only modify files within this scope")
  lines.push("- Do NOT import from other scope folders directly")

  return lines.join("\n")
}

/** Build sub-agent config from folder scope */
function buildSubAgentConfig(scope: FolderScope): SubAgentConfig {
  const agentName = scope.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "-agent"

  return {
    name: agentName,
    scope: scope.path,
    model: recommendModel(scope),
    instructions: generateInstructions(scope),
  }
}

/** Serialize sub-agent config to YAML string */
function toYaml(config: SubAgentConfig): string {
  const lines: string[] = []

  lines.push(`${config.name}:`)
  lines.push(`  scope: "${config.scope}"`)
  lines.push(`  model: ${config.model}`)
  lines.push(`  instructions: |`)
  for (const line of config.instructions.split("\n")) {
    lines.push(`    ${line}`)
  }

  return lines.join("\n")
}

/** Load existing sub-agents.yml if present */
function loadExistingSubAgents(cwd: string): Map<string, SubAgentConfig> | null {
  const ymlPath = path.join(cwd, ".kody", "sub-agents.yml")
  if (!fs.existsSync(ymlPath)) return null

  try {
    const content = fs.readFileSync(ymlPath, "utf-8")
    const configs = parseSubAgentsYaml(content)
    if (configs.length > 0) return new Map(configs.map(c => [c.name, c]))
  } catch { /* ignore */ }

  return null
}

/** Parse existing sub-agents.yml to preserve user overrides */
function parseSubAgentsYaml(content: string): SubAgentConfig[] {
  const configs: SubAgentConfig[] = []
  const lines = content.split("\n")

  let currentAgent: Partial<SubAgentConfig> | null = null
  let instructionsLines: string[] = []
  let inInstructions = false

  for (const line of lines) {
    // Skip comments and empty lines at top level
    if (line.trim() === "" || line.trim().startsWith("#")) continue

    // New agent definition
    const agentMatch = line.match(/^([a-zA-Z0-9_-]+):\s*$/)
    if (agentMatch && !inInstructions) {
      if (currentAgent?.name && currentAgent.instructions) {
        configs.push(currentAgent as SubAgentConfig)
      }
      currentAgent = { name: agentMatch[1], scope: "", model: "haiku", instructions: "" }
      instructionsLines = []
      continue
    }

    // Scope
    const scopeMatch = line.match(/^\s+scope:\s*["']?([^"']+)["']?\s*$/)
    if (scopeMatch && currentAgent) {
      currentAgent.scope = scopeMatch[1]
      continue
    }

    // Model
    const modelMatch = line.match(/^\s+model:\s*([a-z]+)\s*$/)
    if (modelMatch && currentAgent) {
      currentAgent.model = modelMatch[1] as "haiku" | "sonnet" | "opus"
      continue
    }

    // Instructions block
    const instructionsStartMatch = line.match(/^\s+instructions:\s*\|?\s*$/)
    if (instructionsStartMatch && currentAgent) {
      inInstructions = true
      instructionsLines = []
      continue
    }

    // Inside instructions block
    if (inInstructions && currentAgent) {
      const indentMatch = line.match(/^(\s{4,})(.*)$/)
      if (indentMatch) {
        instructionsLines.push(indentMatch[2])
      } else if (line.trim() === "" || line.match(/^\s+[a-zA-Z]+:\s/)) {
        // End of instructions block
        inInstructions = false
        currentAgent.instructions = instructionsLines.join("\n").trim()
      }
    }
  }

  // Final agent
  if (currentAgent?.name && currentAgent.instructions) {
    configs.push(currentAgent as SubAgentConfig)
  }

  return configs
}

/** Merge generated configs with existing user overrides */
function mergeWithExisting(
  generated: SubAgentConfig[],
  existing: Map<string, SubAgentConfig> | null,
): SubAgentConfig[] {
  if (!existing) return generated

  // User overrides take precedence for existing agents
  const merged: SubAgentConfig[] = []
  const generatedMap = new Map(generated.map(g => [g.name, g]))

  for (const [name, existingConfig] of existing.entries()) {
    if (generatedMap.has(name)) {
      // Merge: keep user's scope and model, use generated instructions
      const gen = generatedMap.get(name)!
      merged.push({
        name: existingConfig.name,
        scope: existingConfig.scope || gen.scope,
        model: existingConfig.model || gen.model,
        instructions: existingConfig.instructions || gen.instructions,
      })
      generatedMap.delete(name)
    } else {
      // Keep user's custom agents
      merged.push(existingConfig)
    }
  }

  // Add new generated agents
  merged.push(...generatedMap.values())

  return merged
}

/** Main entry: generate sub-agents.yml from project structure */
export function generateSubAgentsYml(cwd: string, force: boolean): { generated: number; existing: number; skipped: boolean } {
  const ymlPath = path.join(cwd, ".kody", "sub-agents.yml")

  // Detect project structure
  const detection = detectProjectStructure(cwd)

  if (detection.structureType === "single" || detection.scopes.length === 0) {
    // No folder structure — skip generation, remove file if exists
    if (fs.existsSync(ymlPath) && force) {
      fs.unlinkSync(ymlPath)
    }
    return { generated: 0, existing: 0, skipped: true }
  }

  // Load existing configs for user override preservation
  const existing = force ? null : loadExistingSubAgents(cwd)

  // Build config for each scope
  const configs = detection.scopes.map(buildSubAgentConfig)

  // Merge with existing
  const merged = mergeWithExisting(configs, existing)

  // Generate YAML
  const header = `# Folder-scoped sub-agents\n# Generated by Kody bootstrap\n# User can edit this file to customize agents\n\n`
  const yamlContent = header + merged.map(toYaml).join("\n\n") + "\n"

  // Write file
  fs.mkdirSync(path.dirname(ymlPath), { recursive: true })
  fs.writeFileSync(ymlPath, yamlContent)

  return {
    generated: configs.length,
    existing: existing?.size ?? 0,
    skipped: false,
  }
}

/** Async version using LLM for enhanced instruction generation */
export async function generateSubAgentsYmlWithLLM(
  cwd: string,
  model: string,
  force: boolean,
): Promise<{ generated: number; existing: number; skipped: boolean; enhanced: number }> {
  const ymlPath = path.join(cwd, ".kody", "sub-agents.yml")

  // Detect project structure
  const detection = detectProjectStructure(cwd)

  if (detection.structureType === "single" || detection.scopes.length === 0) {
    if (fs.existsSync(ymlPath) && force) {
      fs.unlinkSync(ymlPath)
    }
    return { generated: 0, existing: 0, skipped: true, enhanced: 0 }
  }

  // Load existing configs
  const existing = force ? null : loadExistingSubAgents(cwd)

  // Build basic configs
  const basicConfigs = detection.scopes.map(buildSubAgentConfig)

  // LLM enhancement for scopes with significant code
  let enhancedCount = 0
  const enhancedConfigs: SubAgentConfig[] = []

  for (const scope of detection.scopes) {
    if (scope.fileCount >= 10) {
      try {
        const enhanced = await enhanceInstructionsWithLLM(scope, model, cwd)
        if (enhanced) {
          enhancedConfigs.push(enhanced)
          enhancedCount++
          continue
        }
      } catch { /* ignore LLM errors, use basic */ }
    }
    enhancedConfigs.push(basicConfigs.find(c => c.name === scope.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "-agent")!)
  }

  // Merge with existing
  const merged = mergeWithExisting(enhancedConfigs, existing)

  // Generate YAML
  const header = `# Folder-scoped sub-agents\n# Generated by Kody bootstrap\n# User can edit this file to customize agents\n\n`
  const yamlContent = header + merged.map(toYaml).join("\n\n") + "\n"

  fs.mkdirSync(path.dirname(ymlPath), { recursive: true })
  fs.writeFileSync(ymlPath, yamlContent)

  return {
    generated: basicConfigs.length,
    existing: existing?.size ?? 0,
    skipped: false,
    enhanced: enhancedCount,
  }
}

/** Use LLM to enhance instructions based on actual code patterns */
async function enhanceInstructionsWithLLM(scope: FolderScope, model: string, cwd: string): Promise<SubAgentConfig | null> {
  // Gather code samples
  const samples: string[] = []
  for (const file of scope.sampleFiles.slice(0, 5)) {
    try {
      const rel = path.relative(cwd, file)
      const content = fs.readFileSync(file, "utf-8").slice(0, 2000)
      samples.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``)
    } catch { /* ignore */ }
  }

  const prompt = `Analyze this folder "${scope.name}" (path: ${scope.path}) and generate enhanced instructions for a sub-agent.

## Folder Context
- Framework: ${scope.framework ?? "unknown"}
- File count: ${scope.fileCount}
- Export style: ${scope.exportStyle}
- Test framework: ${scope.testFramework ?? "none"}
- Dependencies: ${scope.dependencies.slice(0, 10).join(", ")}

## Code Samples
${samples.join("\n\n")}

## Your Task
Generate detailed instructions for a sub-agent that will implement code in this folder.

Include:
1. Specific patterns found in the code (naming, imports, exports)
2. Error handling patterns
3. Any framework-specific conventions
4. Cross-folder import restrictions

Output ONLY valid YAML like:
name: ${scope.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-agent
scope: "${scope.path}"
model: ${recommendModel(scope)}
instructions: |
  <detailed instructions>

No markdown fences. No explanation. Just the YAML.`

  return new Promise((resolve) => {
    const child = spawn("claude", [
      "--print",
      "--model", model,
      "--dangerously-skip-permissions",
    ], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve(null)
    }, 60000)

    if (child.stdin) {
      child.stdin.write(prompt, () => child.stdin!.end())
    }

    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        const output = Buffer.concat(stdoutChunks).toString().trim()
        try {
          const config = parseSubAgentFromLLMOutput(output, scope)
          resolve(config)
        } catch {
          resolve(null)
        }
      } else {
        resolve(null)
      }
    })

    child.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

function parseSubAgentFromLLMOutput(output: string, fallbackScope: FolderScope): SubAgentConfig {
  const lines = output.split("\n")
  const config: Partial<SubAgentConfig> = {
    name: fallbackScope.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "-agent",
    scope: fallbackScope.path,
    model: recommendModel(fallbackScope),
    instructions: "",
  }

  let inInstructions = false
  const instructionLines: string[] = []

  for (const line of lines) {
    const nameMatch = line.match(/^name:\s*(.+)\s*$/)
    if (nameMatch) {
      config.name = nameMatch[1].trim()
      continue
    }

    const scopeMatch = line.match(/^scope:\s*["']?([^"']+)["']?\s*$/)
    if (scopeMatch) {
      config.scope = scopeMatch[1].trim()
      continue
    }

    const modelMatch = line.match(/^model:\s*(haiku|sonnet|opus)\s*$/)
    if (modelMatch) {
      config.model = modelMatch[1] as "haiku" | "sonnet" | "opus"
      continue
    }

    const instructionsMatch = line.match(/^instructions:\s*\|?\s*$/)
    if (instructionsMatch) {
      inInstructions = true
      continue
    }

    if (inInstructions && line.match(/^\s{4}/)) {
      instructionLines.push(line.trim())
    } else if (inInstructions && line.trim() === "") {
      instructionLines.push("")
    } else if (inInstructions && !line.match(/^\s/)) {
      inInstructions = false
    }
  }

  config.instructions = instructionLines.join("\n").trim()

  if (!config.instructions) {
    config.instructions = generateInstructions(fallbackScope)
  }

  return config as SubAgentConfig
}

/** Parse sub-agents.yml into structured format for pipeline use */
export function loadSubAgents(cwd: string): SubAgentConfig[] {
  const ymlPath = path.join(cwd, ".kody", "sub-agents.yml")
  if (!fs.existsSync(ymlPath)) return []

  try {
    const content = fs.readFileSync(ymlPath, "utf-8")
    return parseSubAgentsYaml(content)
  } catch {
    return []
  }
}
