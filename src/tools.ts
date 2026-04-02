import * as fs from "fs"
import * as path from "path"
import { execSync } from "child_process"
import { parse as parseYaml } from "yaml"
import { logger } from "./logger.js"
import type { ResolvedTool } from "./types.js"

export type { ResolvedTool }

export interface ToolDeclaration {
  name: string
  detect: string[]
  stages: string[]
  setup: string
  skill: string
}

export function loadToolDeclarations(projectDir: string): ToolDeclaration[] {
  const toolsPath = path.join(projectDir, ".kody", "tools.yml")
  if (!fs.existsSync(toolsPath)) return []

  try {
    const raw = fs.readFileSync(toolsPath, "utf-8")
    const parsed = parseYaml(raw)
    if (!parsed || typeof parsed !== "object") return []

    return Object.entries(parsed).map(([name, value]) => {
      const v = value as Record<string, unknown>
      return {
        name,
        detect: Array.isArray(v.detect) ? v.detect : [],
        stages: Array.isArray(v.stages) ? v.stages : [],
        setup: typeof v.setup === "string" ? v.setup : "",
        skill: typeof v.skill === "string" ? v.skill : "",
      }
    })
  } catch (err) {
    logger.warn(`Failed to parse .kody/tools.yml: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

function resolveSkillContent(skillFilename: string, projectDir: string): string {
  if (!skillFilename) return ""

  // Try project-level first
  const projectSkill = path.join(projectDir, ".kody", "skills", skillFilename)
  if (fs.existsSync(projectSkill)) {
    return fs.readFileSync(projectSkill, "utf-8")
  }

  // Fall back to engine-shipped skills
  const scriptDir = new URL(".", import.meta.url).pathname
  const candidates = [
    path.resolve(scriptDir, "..", "skills", skillFilename),
    path.resolve(scriptDir, "..", "..", "skills", skillFilename),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf-8")
    }
  }

  logger.warn(`Skill file not found: ${skillFilename}`)
  return ""
}

export function detectTools(declarations: ToolDeclaration[], projectDir: string): ResolvedTool[] {
  const resolved: ResolvedTool[] = []

  for (const decl of declarations) {
    const detected = decl.detect.some((pattern) => fs.existsSync(path.join(projectDir, pattern)))
    if (!detected) continue

    const skillContent = resolveSkillContent(decl.skill, projectDir)
    resolved.push({
      name: decl.name,
      stages: decl.stages,
      setup: decl.setup,
      skillContent,
    })
  }

  return resolved
}

export function runToolSetup(tools: ResolvedTool[], projectDir: string): void {
  for (const tool of tools) {
    if (!tool.setup) continue
    try {
      logger.info(`  Setting up ${tool.name}: ${tool.setup}`)
      execSync(tool.setup, { cwd: projectDir, timeout: 120_000, stdio: "pipe" })
      logger.info(`  ✓ ${tool.name} setup complete`)
    } catch (err) {
      logger.warn(`  ⚠ ${tool.name} setup failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function getToolSkillsForStage(tools: ResolvedTool[], stageName: string): string {
  const matched = tools.filter((t) => t.stages.includes(stageName) && t.skillContent)
  if (matched.length === 0) return ""

  const sections = matched.map((t) => `### ${t.name}\n\n${t.skillContent}`)
  return `## Available Tools\n\nThe following tools are installed and ready to use in this environment.\n\n${sections.join("\n\n")}`
}
