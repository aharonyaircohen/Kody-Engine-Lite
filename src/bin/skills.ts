import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import { FRONTEND_DEPS } from "./config-detection.js"

interface SkillMapping {
  package: string
  label: string
}

const SKILL_MAPPINGS: { detect: (deps: Record<string, string>) => boolean; skills: SkillMapping[] }[] = [
  {
    detect: (deps) => "next" in deps,
    skills: [
      { package: "vercel-labs/agent-skills@vercel-react-best-practices", label: "React best practices (Vercel)" },
    ],
  },
  {
    detect: (deps) => "react" in deps && !("next" in deps),
    skills: [
      { package: "vercel-labs/agent-skills@vercel-react-best-practices", label: "React best practices (Vercel)" },
    ],
  },
  {
    detect: (deps) => FRONTEND_DEPS.some((d) => d in deps),
    skills: [
      { package: "microsoft/playwright-cli@playwright-cli", label: "Playwright browser automation" },
    ],
  },
]

export function detectSkillsForProject(cwd: string): SkillMapping[] {
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return []

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

    const seen = new Set<string>()
    const skills: SkillMapping[] = []

    for (const mapping of SKILL_MAPPINGS) {
      if (mapping.detect(allDeps)) {
        for (const skill of mapping.skills) {
          if (!seen.has(skill.package)) {
            seen.add(skill.package)
            skills.push(skill)
          }
        }
      }
    }

    return skills
  } catch {
    return []
  }
}

export function installSkillsForProject(cwd: string): string[] {
  const skills = detectSkillsForProject(cwd)
  if (skills.length === 0) {
    console.log("  ○ No skills to install (no frontend framework detected)")
    return []
  }

  let installedSkills: Record<string, unknown> = {}
  const lockPath = path.join(cwd, "skills-lock.json")
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
      installedSkills = lock.skills ?? {}
    } catch { /* ignore */ }
  }

  const installedPaths: string[] = []

  for (const skill of skills) {
    const skillName = skill.package.split("@").pop() ?? ""

    if (skillName in installedSkills) {
      console.log(`  ○ ${skill.label} — already installed`)
      const agentPath = `.agents/skills/${skillName}`
      const claudePath = `.claude/skills/${skillName}`
      if (fs.existsSync(path.join(cwd, agentPath))) installedPaths.push(agentPath)
      if (fs.existsSync(path.join(cwd, claudePath))) installedPaths.push(claudePath)
      continue
    }

    try {
      console.log(`  Installing: ${skill.label} (${skill.package})`)
      execFileSync("npx", ["skills", "add", skill.package, "--yes"], {
        cwd,
        encoding: "utf-8",
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
      })

      const installedName = skill.package.split("@").pop() ?? ""
      const agentPath = `.agents/skills/${installedName}`
      const claudePath = `.claude/skills/${installedName}`
      if (fs.existsSync(path.join(cwd, agentPath))) installedPaths.push(agentPath)
      if (fs.existsSync(path.join(cwd, claudePath))) installedPaths.push(claudePath)

      console.log(`  ✓ ${skill.label}`)
    } catch {
      console.log(`  ✗ ${skill.label} — failed to install`)
    }
  }

  return installedPaths
}
