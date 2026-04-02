import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import { detectArchitectureBasic } from "../architecture-detection.js"
import { discoverQaContext, generateQaGuideFallback, serializeDiscoveryForLLM } from "../qa-guide.js"
import { getProjectConfig, resolveStageConfig, setConfigDir } from "../../config.js"
import { buildExtendInstruction } from "../extend-helpers.js"

export const STEP_STAGES = ["taskify", "plan", "build", "autofix", "review", "review-fix"] as const

function gatherSampleSourceFiles(cwd: string, maxFiles = 3, maxCharsEach = 2000): string {
  const srcDir = path.join(cwd, "src")
  const baseDir = fs.existsSync(srcDir) ? srcDir : cwd
  const results: string[] = []

  function walk(dir: string): { filePath: string; size: number }[] {
    const entries: { filePath: string; size: number }[] = []
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          entries.push(...walk(full))
        } else if (/\.(ts|js)$/.test(entry.name) &&
          !/\.(test|spec|config|d)\.(ts|js)$/.test(entry.name)) {
          try {
            const stat = fs.statSync(full)
            if (stat.size >= 200 && stat.size <= 5000) {
              entries.push({ filePath: full, size: stat.size })
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
    return entries
  }

  const files = walk(baseDir)
    .sort((a, b) => b.size - a.size)
    .slice(0, maxFiles)

  for (const { filePath } of files) {
    const rel = path.relative(cwd, filePath)
    const content = fs.readFileSync(filePath, "utf-8").slice(0, maxCharsEach)
    results.push(`### File: ${rel}\n\`\`\`typescript\n${content}\n\`\`\``)
  }

  return results.join("\n\n")
}

function ghComment(issueNumber: number, body: string, cwd: string): void {
  try {
    let repoSlug = ""
    try {
      const configPath = path.join(cwd, "kody.config.json")
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
        if (config.github?.owner && config.github?.repo) {
          repoSlug = `${config.github.owner}/${config.github.repo}`
        }
      }
    } catch { /* ignore */ }
    if (!repoSlug) return

    execFileSync("gh", [
      "issue", "comment", String(issueNumber),
      "--repo", repoSlug,
      "--body", body,
    ], {
      cwd,
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch { /* best effort */ }
}

interface BootstrapToolEntry {
  name: string
  detect: string[]
  stages: string[]
  setup: string
  skill: string
}

const KNOWN_TOOLS: BootstrapToolEntry[] = [
  {
    name: "playwright",
    detect: ["playwright.config.ts", "playwright.config.js"],
    stages: ["verify"],
    setup: "npx playwright install --with-deps chromium",
    skill: "microsoft/playwright-cli@playwright-cli",
  },
]

export function detectToolsForBootstrap(cwd: string): BootstrapToolEntry[] {
  return KNOWN_TOOLS.filter((tool) =>
    tool.detect.some((pattern) => fs.existsSync(path.join(cwd, pattern))),
  )
}

interface SkillMapping {
  skill: string
  label: string
}

interface FrameworkSkillRule {
  detect: (deps: Record<string, string>) => boolean
  skills: SkillMapping[]
}

const FRAMEWORK_SKILL_RULES: FrameworkSkillRule[] = [
  {
    detect: (deps) => "next" in deps,
    skills: [
      { skill: "vercel-labs/agent-skills@vercel-react-best-practices", label: "React best practices" },
      { skill: "wshobson/agents@nextjs-app-router-patterns", label: "Next.js App Router patterns" },
    ],
  },
  {
    detect: (deps) => "react" in deps && !("next" in deps),
    skills: [
      { skill: "vercel-labs/agent-skills@vercel-react-best-practices", label: "React best practices" },
    ],
  },
  {
    detect: (deps) => "vue" in deps,
    skills: [
      { skill: "antfu/skills@vue", label: "Vue best practices" },
    ],
  },
  {
    detect: (deps) => "svelte" in deps || "@sveltejs/kit" in deps,
    skills: [
      { skill: "ejirocodes/agent-skills@svelte5-best-practices", label: "Svelte best practices" },
    ],
  },
  {
    detect: (deps) => "@angular/core" in deps,
    skills: [
      { skill: "analogjs/angular-skills@angular-component", label: "Angular component patterns" },
    ],
  },
  {
    detect: (deps) => "payload" in deps,
    skills: [
      { skill: "payloadcms/skills@payload", label: "Payload CMS patterns" },
    ],
  },
  {
    detect: (deps) => "tailwindcss" in deps,
    skills: [
      { skill: "wshobson/agents@tailwind-design-system", label: "Tailwind design system" },
    ],
  },
]

export function detectFrameworkSkills(cwd: string): SkillMapping[] {
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return []

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

    const seen = new Set<string>()
    const skills: SkillMapping[] = []

    for (const rule of FRAMEWORK_SKILL_RULES) {
      if (rule.detect(allDeps)) {
        for (const skill of rule.skills) {
          if (!seen.has(skill.skill)) {
            seen.add(skill.skill)
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

export function bootstrapCommand(opts: { force: boolean }, pkgRoot: string) {
  const cwd = process.cwd()
  setConfigDir(cwd)
  const issueNumber = parseInt(process.env.ISSUE_NUMBER ?? "", 10) || 0
  const bootstrapModel = resolveStageConfig(getProjectConfig(), "bootstrap", "cheap").model
  console.log(`\n🔧 Kody Bootstrap — Generating project memory + step files\n`)

  if (issueNumber) {
    ghComment(issueNumber, "🔧 **Bootstrap started** — analyzing project and generating configuration...", cwd)
  }

  // ── Gather project context ──
  const readIfExists = (rel: string, maxChars = 3000) => {
    const p = path.join(cwd, rel)
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8").slice(0, maxChars)
    return null
  }

  let repoContext = ""
  const pkgJson = readIfExists("package.json")
  if (pkgJson) repoContext += `## package.json\n${pkgJson}\n\n`
  const tsconfig = readIfExists("tsconfig.json", 1000)
  if (tsconfig) repoContext += `## tsconfig.json\n${tsconfig}\n\n`
  const readme = readIfExists("README.md", 2000)
  if (readme) repoContext += `## README.md (first 2000 chars)\n${readme}\n\n`
  const claudeMd = readIfExists("CLAUDE.md", 3000)
  if (claudeMd) repoContext += `## CLAUDE.md\n${claudeMd}\n\n`
  const agentsMd = readIfExists("AGENTS.md", 3000)
  if (agentsMd) repoContext += `## AGENTS.md\n${agentsMd}\n\n`

  // Sample source files
  const sampleFiles = gatherSampleSourceFiles(cwd)
  if (sampleFiles) repoContext += `## Sample Source Files\n${sampleFiles}\n\n`

  // Directory structure
  try {
    const topDirs = fs.readdirSync(cwd, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map(e => e.name)
    repoContext += `## Top-level directories\n${topDirs.join(", ")}\n\n`

    const srcDir = path.join(cwd, "src")
    if (fs.existsSync(srcDir)) {
      const srcDirs = fs.readdirSync(srcDir, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name)
      if (srcDirs.length > 0) repoContext += `## src/ subdirectories\n${srcDirs.join(", ")}\n\n`
    }
  } catch { /* ignore */ }

  // Existing config files
  const existingFiles: string[] = []
  for (const f of [".env.example", "CLAUDE.md", ".ai-docs", "vitest.config.ts", "vitest.config.mts", "jest.config.ts", "playwright.config.ts", ".eslintrc.js", "eslint.config.mjs", ".prettierrc"]) {
    if (fs.existsSync(path.join(cwd, f))) existingFiles.push(f)
  }
  if (existingFiles.length) repoContext += `## Config files present\n${existingFiles.join(", ")}\n\n`

  // ── Step 1: Generate project memory via LLM ──
  console.log("── Project Memory ──")
  const memoryDir = path.join(cwd, ".kody", "memory")
  fs.mkdirSync(memoryDir, { recursive: true })
  const archPath = path.join(memoryDir, "architecture.md")
  const conventionsPath = path.join(memoryDir, "conventions.md")

  const existingArch = fs.existsSync(archPath) ? fs.readFileSync(archPath, "utf-8") : ""
  const existingConv = fs.existsSync(conventionsPath) ? fs.readFileSync(conventionsPath, "utf-8") : ""
  const hasExisting = !!(existingArch || existingConv)

  const extendInstruction = hasExisting && !opts.force
    ? buildExtendInstruction(
        `### architecture.md:\n${existingArch}\n\n### conventions.md:\n${existingConv}`,
        "project documentation",
      )
    : ""

  const memoryPrompt = `You are analyzing a project to generate documentation for an autonomous SDLC pipeline.

Given this project context, output ONLY a JSON object with EXACTLY this structure:

{
  "architecture": "# Architecture\\n\\n<markdown content>",
  "conventions": "# Conventions\\n\\n<markdown content>"
}

Rules for architecture (markdown string):
- Be specific about THIS project
- Include: framework, language, database, testing, key directories, data flow
- Reference CLAUDE.md and .ai-docs/ if they exist
- Keep under 50 lines

Rules for conventions (markdown string):
- Extract actual patterns from the project
- If CLAUDE.md exists, reference it
- Keep under 30 lines
${extendInstruction}
Output ONLY valid JSON. No markdown fences. No explanation.

${repoContext}`

  console.log("  ⏳ Analyzing project...")
  try {
    const output = execFileSync("claude", [
      "--print",
      "--model", bootstrapModel,
      "--dangerously-skip-permissions",
      memoryPrompt,
    ], {
      encoding: "utf-8",
      timeout: 90_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()

    const cleaned = output.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const parsed = JSON.parse(cleaned)

    if (parsed.architecture) {
      fs.writeFileSync(archPath, parsed.architecture)
      const lineCount = parsed.architecture.split("\n").length
      console.log(`  ✓ .kody/memory/architecture.md (${lineCount} lines)`)
    }

    if (parsed.conventions) {
      fs.writeFileSync(conventionsPath, parsed.conventions)
      const lineCount = parsed.conventions.split("\n").length
      console.log(`  ✓ .kody/memory/conventions.md (${lineCount} lines)`)
    }
  } catch {
    console.log("  ⚠ LLM analysis failed — creating basic memory files")
    // Fallback: basic detection
    const detected = detectArchitectureBasic(cwd)
    if (detected.length > 0) {
      const timestamp = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(archPath, `# Architecture (auto-detected ${timestamp})\n\n## Overview\n${detected.join("\n")}\n`)
      console.log(`  ✓ .kody/memory/architecture.md (${detected.length} items, basic detection)`)
    }
    fs.writeFileSync(conventionsPath, "# Conventions\n\n<!-- Auto-learned conventions will be appended here -->\n")
    console.log("  ✓ .kody/memory/conventions.md (seed)")
  }

  // ── Step 2: Generate step files via LLM ──
  console.log("\n── Step Files ──")
  const stepsDir = path.join(cwd, ".kody", "steps")
  fs.mkdirSync(stepsDir, { recursive: true })

  const arch = fs.existsSync(archPath) ? fs.readFileSync(archPath, "utf-8") : ""
  const conv = fs.existsSync(conventionsPath) ? fs.readFileSync(conventionsPath, "utf-8") : ""

  console.log("  ⏳ Customizing step files...")
  let stepCount = 0
  for (const stage of STEP_STAGES) {
    const templatePath = path.join(pkgRoot, "prompts", `${stage}.md`)
    if (!fs.existsSync(templatePath)) {
      console.log(`  ✗ ${stage}.md — template not found in engine`)
      continue
    }

    const stepOutputPath = path.join(stepsDir, `${stage}.md`)
    const existingStep = fs.existsSync(stepOutputPath) ? fs.readFileSync(stepOutputPath, "utf-8") : ""
    const isExtend = !!existingStep && !opts.force

    const defaultPrompt = fs.readFileSync(templatePath, "utf-8")
    const contextPlaceholder = "{{TASK_CONTEXT}}"
    const placeholderIdx = defaultPrompt.indexOf(contextPlaceholder)

    // If template has no placeholder, copy as-is
    if (placeholderIdx === -1) {
      fs.copyFileSync(templatePath, stepOutputPath)
      stepCount++
      console.log(`  ✓ ${stage}.md`)
      continue
    }

    const beforePlaceholder = defaultPrompt.slice(0, placeholderIdx).trimEnd()
    const afterPlaceholder = defaultPrompt.slice(placeholderIdx)

    const stepExtendBlock = isExtend
      ? buildExtendInstruction(existingStep, `${stage} step file`)
      : ""

    const customizationPrompt = `You are customizing a Kody pipeline prompt for a specific repository.

## Your Task
Take the prompt template below and APPEND repository-specific sections to it.

## Rules
1. Output the ENTIRE original prompt template UNCHANGED first — copy it exactly, character for character.
2. Then APPEND these three new sections at the end:
   - ## Repo Patterns — Real code examples from this repo that demonstrate the patterns to follow. Include specific file paths, function signatures, and brief code snippets.
   - ## Improvement Areas — Gaps or anti-patterns found in the codebase. Be specific with file paths.
   - ## Acceptance Criteria — A concrete checklist (markdown checkboxes) for "done" in this repo.
3. Be SPECIFIC — reference actual file paths, function names, and conventions from the repo context.
4. Keep each appended section concise (10-20 lines max).
5. Output ONLY the customized prompt markdown. No explanation before or after.
6. Do NOT include the text "${contextPlaceholder}" — it will be appended automatically after your output.
${stepExtendBlock}
## Stage Being Customized
Stage: ${stage}

## Prompt Template (output this EXACTLY, then append your sections)
${beforePlaceholder}

## Repository Context

### Architecture
${arch}

### Conventions
${conv}

### Project Details
${repoContext}

REMINDER: Output the full prompt template first (unchanged), then your three appended sections. Do NOT include "${contextPlaceholder}".`

    try {
      const output = execFileSync("claude", [
        "--print",
        "--model", bootstrapModel,
        "--dangerously-skip-permissions",
        customizationPrompt,
      ], {
        encoding: "utf-8",
        timeout: 90_000,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()

      let cleaned = output.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "")
      cleaned = cleaned.replace(/\n*\{\{TASK_CONTEXT\}\}\s*$/, "").trimEnd()

      // Re-append the placeholder
      const finalPrompt = cleaned + "\n\n" + afterPlaceholder
      fs.writeFileSync(stepOutputPath, finalPrompt)
      stepCount++
      console.log(`  ✓ ${stage}.md (${isExtend ? "extended" : "generated"})`)
    } catch {
      if (!isExtend) {
        console.log(`  ⚠ ${stage}.md — customization failed, using default template`)
        fs.copyFileSync(templatePath, stepOutputPath)
        stepCount++
      } else {
        console.log(`  ⚠ ${stage}.md — extend failed, keeping existing`)
      }
    }
  }
  console.log(`  ✓ Generated ${stepCount} step files in .kody/steps/`)

  // ── Step 2b: Generate QA guide (always run, extend or regenerate) ──
  console.log("\n── QA Guide ──")
  const qaGuidePath = path.join(cwd, ".kody", "qa-guide.md")
  const discovery = discoverQaContext(cwd)
  const hasRoutes = discovery.routes.length > 0 || discovery.collections.length > 0

  if (hasRoutes) {
    const existingQaGuide = fs.existsSync(qaGuidePath) ? fs.readFileSync(qaGuidePath, "utf-8") : ""
    const isQaExtend = !!existingQaGuide && !opts.force
    const serializedDiscovery = serializeDiscoveryForLLM(discovery)

    const qaExtendBlock = isQaExtend
      ? buildExtendInstruction(existingQaGuide, "QA guide")
      : ""

    const qaPrompt = `You are generating a QA guide for an autonomous coding agent that will use Playwright browser tools to visually verify UI changes.

## Discovery Data
${serializedDiscovery}

## Architecture
${arch}

## Conventions
${conv}
${qaExtendBlock}
## Output Format
Generate a markdown QA guide with EXACTLY these sections:

# QA Guide

## Quick Reference
- Dev server command and URL
- Login page URL
- Admin panel URL (if applicable)

## Authentication
### Test Accounts
Table with Role, Email, Password columns.
Use env var references (QA_ADMIN_EMAIL, QA_ADMIN_PASSWORD, etc.) — NOT hardcoded credentials.
If the existing guide has real credentials, PRESERVE them exactly.

### Login Steps
Specific steps for this project's auth system.

### Auth Files
List of auth-related source files.

## Navigation Map
### Admin Panel
For each collection/admin page: the exact URL path, what elements to expect on the page, key fields visible in the form, any custom components.
Example: "/admin/collections/courses — Course edit form with title, slug, description fields. Custom CourseLessonsSorter component shows drag-sortable lessons grouped by chapter."

### Frontend Pages
For each key public route: path, expected content, key interactions to test.

### API Endpoints
For each API route: path, HTTP methods, purpose.

## Component Verification Patterns
For each custom admin component: where to find it in the UI, how to navigate there, what visual elements to verify, interaction tests (click, drag, type).

## Common Test Scenarios
CRUD workflows, auth flows, specific feature verification patterns relevant to this project.

## Environment Setup
Required env vars to start the dev server successfully.

## Dev Server
Command and URL.

## Rules
- Be SPECIFIC to this project — reference actual URLs, collection names, component names
- For admin panels (Payload CMS, etc.), include the exact /admin/collections/{slug} paths
- Include visual assertions: "you should see X", "verify Y is visible"
- Include interaction tests: "click button X", "fill field Y", "drag item Z"
- Keep under 200 lines total
- Output ONLY the markdown. No explanation before or after.`

    console.log("  ⏳ Generating QA guide...")
    try {
      const output = execFileSync("claude", [
        "--print",
        "--model", bootstrapModel,
        "--dangerously-skip-permissions",
        qaPrompt,
      ], {
        encoding: "utf-8",
        timeout: 90_000,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()

      const cleaned = output.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "")
      fs.writeFileSync(qaGuidePath, cleaned)
      console.log(`  ✓ .kody/qa-guide.md (${isQaExtend ? "extended" : "generated"}, ${discovery.routes.length} routes, ${discovery.collections.length} collections)`)
    } catch {
      console.log("  ⚠ LLM QA generation failed — using template fallback")
      const qaGuide = generateQaGuideFallback(discovery)
      fs.writeFileSync(qaGuidePath, qaGuide)
      console.log(`  ✓ .kody/qa-guide.md (fallback, ${discovery.routes.length} routes)`)
    }

    if (discovery.loginPage) console.log(`  ✓ Login page detected: ${discovery.loginPage}`)
    if (discovery.adminPath) console.log(`  ✓ Admin panel detected: ${discovery.adminPath}`)
    if (discovery.collections.length > 0) console.log(`  ✓ ${discovery.collections.length} Payload CMS collections detected`)
    if (discovery.adminComponents.length > 0) console.log(`  ✓ ${discovery.adminComponents.length} custom admin components detected`)
    console.log("  ℹ Add QA_ADMIN_EMAIL, QA_ADMIN_PASSWORD, QA_USER_EMAIL, QA_USER_PASSWORD as GitHub secrets")
  } else {
    console.log("  ○ No routes or collections detected — skipping QA guide")
  }

  // ── Step 3: Create labels ──
  console.log("\n── Labels ──")
  try {
    let repoSlug = ""
    try {
      const configPath = path.join(cwd, "kody.config.json")
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
        if (config.github?.owner && config.github?.repo) {
          repoSlug = `${config.github.owner}/${config.github.repo}`
        }
      }
    } catch { /* ignore */ }

    if (repoSlug) {
      const labels = [
        { name: "kody:backlog", color: "e4e669", description: "Issue created, not yet assigned to Kody" },
        { name: "kody:planning", color: "c5def5", description: "Kody is analyzing and planning" },
        { name: "kody:building", color: "0e8a16", description: "Kody is building code" },
        { name: "kody:verifying", color: "fbca04", description: "Kody is verifying (lint/test/typecheck)" },
        { name: "kody:review", color: "fbca04", description: "Kody is reviewing code" },
        { name: "kody:fixing", color: "0e8a16", description: "Kody is applying review fixes" },
        { name: "kody:shipping", color: "1d76db", description: "Kody is creating the pull request" },
        { name: "kody:done", color: "0e8a16", description: "Kody completed successfully" },
        { name: "kody:failed", color: "d93f0b", description: "Kody pipeline failed" },
        { name: "kody:waiting", color: "fef2c0", description: "Kody is waiting for answers" },
        { name: "kody:low", color: "bfdadc", description: "Low complexity — skip plan/review" },
        { name: "kody:medium", color: "c5def5", description: "Medium complexity — skip review-fix" },
        { name: "kody:high", color: "d4c5f9", description: "High complexity — full pipeline" },
        { name: "kody:feature", color: "0e8a16", description: "New feature" },
        { name: "kody:bugfix", color: "d93f0b", description: "Bug fix" },
        { name: "kody:refactor", color: "fbca04", description: "Code refactoring" },
        { name: "kody:docs", color: "0075ca", description: "Documentation" },
        { name: "kody:chore", color: "e4e669", description: "Maintenance task" },
      ]

      for (const label of labels) {
        try {
          execFileSync("gh", [
            "label", "create", label.name,
            "--repo", repoSlug,
            "--color", label.color,
            "--description", label.description,
            "--force",
          ], {
            cwd,
            encoding: "utf-8",
            timeout: 10_000,
            stdio: ["pipe", "pipe", "pipe"],
          })
          console.log(`  ✓ ${label.name}`)
        } catch {
          try {
            execFileSync("gh", ["label", "list", "--repo", repoSlug, "--search", label.name], {
              cwd,
              encoding: "utf-8",
              timeout: 10_000,
              stdio: ["pipe", "pipe", "pipe"],
            })
            console.log(`  ○ ${label.name} (exists)`)
          } catch {
            console.log(`  ✗ ${label.name} — failed to create`)
          }
        }
      }
    } else {
      console.log("  ○ Skipped — could not determine repo from kody.config.json")
    }
  } catch {
    console.log("  ○ Label creation skipped")
  }

  // ── Step 3b: Generate tools.yml ──
  console.log("\n── Tools ──")
  const toolsYmlPath = path.join(cwd, ".kody", "tools.yml")
  if (!fs.existsSync(toolsYmlPath) || opts.force) {
    const detected = detectToolsForBootstrap(cwd)
    const header = `# Kody Tools Configuration\n# Find skills at https://skills.sh\n`
    if (detected.length > 0) {
      const entries = detected.map((t) =>
        `${t.name}:\n  detect: ${JSON.stringify(t.detect)}\n  stages: ${JSON.stringify(t.stages)}\n  setup: "${t.setup}"\n  skill: "${t.skill}"`
      ).join("\n\n")
      fs.writeFileSync(toolsYmlPath, `${header}\n${entries}\n`)
      for (const t of detected) console.log(`  ✓ ${t.name} detected`)
    } else {
      const example = `${header}#\n# Example:\n# playwright:\n#   detect: ["playwright.config.ts", "playwright.config.js"]\n#   stages: [verify]\n#   setup: "npx playwright install --with-deps chromium"\n#   skill: "microsoft/playwright-cli@playwright-cli"\n`
      fs.writeFileSync(toolsYmlPath, example)
      console.log("  ○ No tools detected — template created")
    }
  } else {
    console.log("  ○ .kody/tools.yml (already exists, keeping)")
  }

  // ── Step 3c: Install skills ──
  console.log("\n── Skills ──")
  const installedSkillPaths: string[] = []

  // Collect all skills to install: tool skills + framework skills
  const allSkills: SkillMapping[] = []
  const seen = new Set<string>()

  // Tool skills
  for (const tool of detectToolsForBootstrap(cwd)) {
    if (tool.skill && !seen.has(tool.skill)) {
      seen.add(tool.skill)
      allSkills.push({ skill: tool.skill, label: `${tool.name} CLI` })
    }
  }

  // Framework skills
  for (const mapping of detectFrameworkSkills(cwd)) {
    if (!seen.has(mapping.skill)) {
      seen.add(mapping.skill)
      allSkills.push(mapping)
    }
  }

  if (allSkills.length > 0) {
    for (const { skill, label } of allSkills) {
      try {
        console.log(`  Installing: ${label} (${skill})`)
        execFileSync("npx", ["skills", "add", skill, "--yes"], {
          cwd,
          encoding: "utf-8",
          timeout: 60_000,
          stdio: ["pipe", "pipe", "pipe"],
        })
        // Collect installed paths
        const skillName = skill.split("@").pop() ?? ""
        for (const dir of [".claude/skills", ".agents/skills"]) {
          const skillPath = path.join(dir, skillName)
          if (fs.existsSync(path.join(cwd, skillPath))) {
            installedSkillPaths.push(skillPath)
          }
        }
        console.log(`  ✓ ${label}`)
      } catch {
        console.log(`  ✗ ${label} — failed to install`)
      }
    }
  } else {
    console.log("  ○ No skills to install (no frameworks detected)")
  }

  // Add skills-lock.json if created
  if (fs.existsSync(path.join(cwd, "skills-lock.json"))) {
    installedSkillPaths.push("skills-lock.json")
  }

  // ── Step 4: Format, commit and push ──
  console.log("\n── Git ──")
  const filesToCommit = [
    ".kody/memory/architecture.md",
    ".kody/memory/conventions.md",
    ".kody/qa-guide.md",
    ".kody/tools.yml",
    ...installedSkillPaths,
  ].filter((f) => fs.existsSync(path.join(cwd, f)))

  for (const stage of STEP_STAGES) {
    const stepFile = `.kody/steps/${stage}.md`
    if (fs.existsSync(path.join(cwd, stepFile))) {
      filesToCommit.push(stepFile)
    }
  }

  // Format with prettier if available
  if (filesToCommit.length > 0) {
    try {
      const fullPaths = filesToCommit.map((f) => path.join(cwd, f))
      for (let pass = 0; pass < 2; pass++) {
        execFileSync("npx", ["prettier", "--write", ...fullPaths], {
          cwd,
          encoding: "utf-8",
          timeout: 30_000,
          stdio: ["pipe", "pipe", "pipe"],
        })
      }
      console.log("  ✓ Formatted files with Prettier")
    } catch {
      // Not critical
    }
  }

  const isCI = !!process.env.GITHUB_ACTIONS

  if (filesToCommit.length > 0) {
    try {
      if (isCI) {
        // In GH Actions: create branch and PR
        const branchName = `kody-bootstrap-${Date.now()}`
        execFileSync("git", ["checkout", "-b", branchName], { cwd, stdio: "pipe" })
        execFileSync("git", ["add", ...filesToCommit], { cwd, stdio: "pipe" })
        const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf-8" }).trim()
        if (staged) {
          execFileSync("git", ["commit", "-m", "chore: Add Kody project memory and step files\n\nBootstrap Kody Engine with project-specific architecture, conventions, and pipeline step files."], { cwd, stdio: "pipe" })
          execFileSync("git", ["push", "-u", "origin", branchName], { cwd, stdio: "pipe", timeout: 60_000 })
          console.log(`  ✓ Pushed branch: ${branchName}`)

          // Detect default branch for PR base
          let baseBranch = "main"
          try {
            const configPath = path.join(cwd, "kody.config.json")
            if (fs.existsSync(configPath)) {
              const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
              baseBranch = config.git?.defaultBranch ?? "main"
            }
          } catch { /* keep main */ }

          // Create PR
          try {
            const prUrl = execFileSync("gh", [
              "pr", "create",
              "--title", "chore: Bootstrap Kody Engine",
              "--body", "## Summary\n\n- Add project memory (architecture + conventions)\n- Add customized pipeline step files\n\nGenerated by `@kody bootstrap`.",
              "--base", baseBranch,
              "--head", branchName,
            ], {
              cwd,
              encoding: "utf-8",
              timeout: 30_000,
              stdio: ["pipe", "pipe", "pipe"],
            }).trim()
            console.log(`  ✓ Created PR: ${prUrl}`)
            if (issueNumber) {
              ghComment(issueNumber, `✅ **Bootstrap complete** — PR created: ${prUrl}\n\nReview and merge to activate project-specific pipeline configuration.`, cwd)
            }
          } catch (prErr: any) {
            const stderr = prErr?.stderr?.toString().trim()
            const reason = stderr || (prErr instanceof Error ? prErr.message : String(prErr))
            console.log(`  ○ PR creation failed: ${reason}`)
            if (issueNumber) {
              ghComment(issueNumber, `⚠️ **Bootstrap complete** — files generated and pushed to branch \`${branchName}\`, but PR creation failed.\n\n**Reason:** ${reason}\n\nCreate it manually.`, cwd)
            }
          }
        } else {
          console.log("  ○ No new changes to commit")
        }
      } else {
        // Local: commit to current branch
        execFileSync("git", ["add", ...filesToCommit], { cwd, stdio: "pipe" })
        const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf-8" }).trim()
        if (staged) {
          execFileSync("git", ["commit", "-m", "chore: Add Kody project memory and step files\n\nBootstrap Kody Engine with project-specific architecture, conventions, and pipeline step files."], { cwd, stdio: "pipe" })
          console.log(`  ✓ Committed: ${filesToCommit.join(", ")}`)
          try {
            execFileSync("git", ["push"], { cwd, stdio: "pipe", timeout: 60_000 })
            console.log("  ✓ Pushed to origin")
          } catch {
            console.log("  ○ Push failed — run 'git push' manually")
          }
        } else {
          console.log("  ○ No new changes to commit")
        }
      }
    } catch (err) {
      console.log(`  ○ Git commit skipped: ${err instanceof Error ? err.message : err}`)
      if (issueNumber) {
        ghComment(issueNumber, `❌ **Bootstrap failed** — git operation error: ${err instanceof Error ? err.message : err}`, cwd)
      }
    }
  }

  console.log("\n── Done ──")
  console.log("  ✓ Project bootstrap complete!")
  console.log("  Kody now has project-specific memory and customized step files.\n")
}
