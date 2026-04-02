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
      }
    })
  } catch (err) {
    logger.warn(`Failed to parse .kody/tools.yml: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export function detectTools(declarations: ToolDeclaration[], projectDir: string): ResolvedTool[] {
  const resolved: ResolvedTool[] = []

  for (const decl of declarations) {
    const detected = decl.detect.some((pattern) => fs.existsSync(path.join(projectDir, pattern)))
    if (!detected) continue

    resolved.push({
      name: decl.name,
      stages: decl.stages,
      setup: decl.setup,
    })
  }

  return resolved
}

export function runToolSetup(tools: ResolvedTool[], projectDir: string): void {
  for (const tool of tools) {
    if (tool.setup) {
      try {
        logger.info(`  Setting up ${tool.name}: ${tool.setup}`)
        execSync(tool.setup, { cwd: projectDir, timeout: 120_000, stdio: "pipe" })
        logger.info(`  ✓ ${tool.name} setup complete`)
      } catch (err) {
        logger.warn(`  ⚠ ${tool.name} setup failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Install matching skill from skills.sh
    try {
      logger.info(`  Installing skill for ${tool.name} from skills.sh`)
      execSync(`npx skills add --skill ${tool.name} --yes`, { cwd: projectDir, timeout: 60_000, stdio: "pipe" })
      logger.info(`  ✓ ${tool.name} skill installed`)
    } catch (err) {
      logger.warn(`  ⚠ ${tool.name} skill install failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
