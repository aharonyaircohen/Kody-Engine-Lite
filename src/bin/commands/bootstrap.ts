import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import type { ChildProcess } from "child_process"

import { detectArchitectureBasic } from "../architecture-detection.js"
import { discoverQaContext, generateQaGuideFallback, serializeDiscoveryForLLM } from "../qa-guide.js"
import { generateSubAgentsYml, loadSubAgents } from "../sub-agent-generator.js"
import { getProjectConfig, resolveStageConfig, setConfigDir, stageNeedsProxy, getLitellmUrl, getAnthropicApiKeyOrDummy } from "../../config.js"
import { buildExtendInstruction } from "../extend-helpers.js"
import { checkLitellmHealth, tryStartLitellm, generateLitellmConfig } from "../../cli/litellm.js"
import { gatherArchitectureContext, execClaudeAsync, MEMORY_FILES, ROUND2_TASKS } from "../bootstrap-context.js"
import { readProjectMemory } from "../../memory.js"

export const STEP_STAGES = ["taskify", "plan", "build", "autofix", "review", "review-fix"] as const

/* ── Activity log resolution ─────────────────────────────────── */

export interface ActivityLogGateway {
  /** Return "OPEN" | "CLOSED" or throw if issue doesn't exist */
  getIssueState(issueNum: number): string
  /** Return the WATCH_ACTIVITY_LOG repo variable value, or null */
  getVariable(): string | null
  /** Search for an open issue by title, return its number or null */
  searchIssue(): number | null
  /** Create the activity log issue, return its number or null */
  createIssue(): number | null
  /** Pin an issue (best-effort) */
  pinIssue(issueNum: number): void
}

export interface ActivityLogResult {
  issueNumber: number | null
  source: "config" | "variable" | "search" | "created" | null
  warnings: string[]
}

/**
 * Resolve the activity log issue number through a priority chain:
 * 1. Config value (validated open)
 * 2. GitHub Actions variable (validated open)
 * 3. Search by title
 * 4. Create new
 */
export function resolveActivityLog(
  configActivityLog: number | undefined,
  gateway: ActivityLogGateway,
): ActivityLogResult {
  const warnings: string[] = []

  // 1. Check config value and validate it exists & is open
  if (configActivityLog) {
    try {
      const state = gateway.getIssueState(configActivityLog)
      if (state === "OPEN") {
        return { issueNumber: configActivityLog, source: "config", warnings }
      }
      warnings.push(`Config activityLog #${configActivityLog} is ${state || "missing"} — will re-resolve`)
    } catch {
      warnings.push(`Config activityLog #${configActivityLog} not found — will re-resolve`)
    }
  }

  // 2. Check GitHub Actions variable and validate
  const varValue = gateway.getVariable()
  if (varValue && !isNaN(parseInt(varValue, 10))) {
    const candidate = parseInt(varValue, 10)
    try {
      const state = gateway.getIssueState(candidate)
      if (state === "OPEN") {
        return { issueNumber: candidate, source: "variable", warnings }
      }
      warnings.push(`Variable WATCH_ACTIVITY_LOG #${candidate} is ${state || "missing"} — will re-resolve`)
    } catch {
      warnings.push(`Variable WATCH_ACTIVITY_LOG #${candidate} not found — will re-resolve`)
    }
  }

  // 3. Search for existing open activity log issue
  const found = gateway.searchIssue()
  if (found) {
    return { issueNumber: found, source: "search", warnings }
  }

  // 4. Create only if none exists
  const created = gateway.createIssue()
  if (created) {
    gateway.pinIssue(created)
    return { issueNumber: created, source: "created", warnings }
  }

  return { issueNumber: null, source: null, warnings }
}

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
  run?: string
}

const KNOWN_TOOLS: BootstrapToolEntry[] = [
  {
    name: "playwright",
    detect: ["playwright.config.ts", "playwright.config.js"],
    stages: ["verify"],
    setup: "npx playwright install --with-deps chromium",
    skill: "microsoft/playwright-cli@playwright-cli",
    run: "npx playwright test",
  },
]

export function detectToolsForBootstrap(cwd: string): BootstrapToolEntry[] {
  return KNOWN_TOOLS.filter((tool) =>
    tool.detect.some((pattern) => fs.existsSync(path.join(cwd, pattern))),
  )
}

interface SearchedSkill {
  ref: string    // e.g. "payloadcms/skills@payload"
  name: string   // e.g. "payload" (part after @)
  installs: number
}

const FRAMEWORK_KEYWORDS: Record<string, string> = {
  next: "nextjs",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "@angular/core": "angular",
  payload: "payload cms",
  tailwindcss: "tailwind",
  nuxt: "nuxt",
  astro: "astro",
  "solid-js": "solidjs",
  express: "express",
  fastify: "fastify",
  prisma: "prisma",
}

function parseSkillsSearchOutput(output: string): SearchedSkill[] {
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "")
  const results: SearchedSkill[] = []

  for (const line of stripped.split("\n")) {
    // Match lines like: "owner/repo@skill-name 12.8K installs"
    const match = line.match(/^([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)\s+([\d.]+)([KM]?)\s+installs/)
    if (!match) continue

    const ref = match[1]
    const name = ref.split("@").pop() ?? ""
    let installs = parseFloat(match[2])
    if (match[3] === "K") installs *= 1000
    if (match[3] === "M") installs *= 1_000_000

    results.push({ ref, name, installs })
  }

  return results
}

export function extractDependencyNames(pkgJsonStr: string | null): string {
  if (!pkgJsonStr) return "Unknown"
  try {
    return Object.keys(JSON.parse(pkgJsonStr).dependencies ?? {}).join(", ") || "none"
  } catch {
    return "unknown (parse error)"
  }
}

const REJECT_PATTERNS = ["best-practices", "patterns", "standards", "conventions", "coding-style"]

export function filterSkillsByDependencies(skills: SearchedSkill[], pkgJson: string | null): { kept: SearchedSkill[]; rejected: { name: string; reason: string }[] } {
  const depNames = new Set<string>()
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson)
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        depNames.add(name.toLowerCase())
        const base = name.replace(/^@[^/]+\//, "").split("-")[0]
        if (base) depNames.add(base.toLowerCase())
      }
    } catch { /* ignore */ }
  }

  const kept: SearchedSkill[] = []
  const rejected: { name: string; reason: string }[] = []

  // Also extract first segment of each skill name for matching (e.g., "tailwind-design-system" → "tailwind")
  for (const skill of skills) {
    const nameLower = skill.name.toLowerCase()
    if (REJECT_PATTERNS.some((p) => nameLower.includes(p))) {
      rejected.push({ name: skill.name, reason: "generic pattern collection" })
    } else {
      const skillSegments = nameLower.split("-")
      const matched = depNames.has(nameLower)
        || [...depNames].some((d) => nameLower.includes(d) || d.includes(nameLower))
        || skillSegments.some((seg) => seg.length >= 4 && depNames.has(seg))
        || [...depNames].some((d) => skillSegments.some((seg) => seg.length >= 4 && d.includes(seg)))
      if (matched) {
        kept.push(skill)
      } else {
        rejected.push({ name: skill.name, reason: "no matching dependency" })
      }
    }
  }

  return { kept, rejected }
}

export function detectProjectKeywords(cwd: string): string[] {
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return []

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }
    const keywords: string[] = []

    for (const [dep, keyword] of Object.entries(FRAMEWORK_KEYWORDS)) {
      if (dep in allDeps) keywords.push(keyword)
    }

    return keywords
  } catch {
    return []
  }
}

export function searchSkills(keywords: string[], exclude: Set<string>, limit: number): SearchedSkill[] {
  const seen = new Set<string>()
  const perKeyword: SearchedSkill[][] = []

  for (const keyword of keywords) {
    try {
      const output = execFileSync("npx", ["skills", "find", keyword], {
        encoding: "utf-8",
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const results: SearchedSkill[] = []
      for (const skill of parseSkillsSearchOutput(output)) {
        if (!exclude.has(skill.name)) {
          results.push(skill)
        }
      }
      perKeyword.push(results)
    } catch {
      // Search failed for this keyword, continue with others
    }
  }

  // Round-robin: take top result from each keyword in turn
  // This ensures every detected framework gets representation
  const selected: SearchedSkill[] = []
  let round = 0
  while (selected.length < limit) {
    let added = false
    for (const results of perKeyword) {
      if (selected.length >= limit) break
      if (round >= results.length) continue
      const candidate = results[round]
      if (!seen.has(candidate.ref)) {
        seen.add(candidate.ref)
        selected.push(candidate)
        added = true
      }
    }
    if (!added) break
    round++
  }

  return selected
}

/** Dot-dirs that belong to the project — everything else with a sole `skills/` child is IDE junk from `npx skills add` */
const KEEP_DOT_DIRS = new Set([
  ".claude", ".agents", ".github", ".git", ".kody",
  ".vscode", ".env.example", ".prettierrc.json", ".yarnrc",
])

/**
 * Remove IDE-specific dot-folders created by `npx skills add`.
 * The skills CLI scaffolds symlink dirs for every supported IDE (Cursor, Windsurf, etc.)
 * but we only use `.claude` and `.agents`. A dir is considered an IDE skill stub if:
 *   1. It starts with "."
 *   2. It's not in the KEEP_DOT_DIRS allowlist
 *   3. Its only child is a `skills/` subdirectory
 */
export function cleanupIdeSkillDirs(cwd: string): void {
  let removed = 0
  for (const entry of fs.readdirSync(cwd)) {
    if (!entry.startsWith(".")) continue
    if (KEEP_DOT_DIRS.has(entry)) continue
    const full = path.join(cwd, entry)
    try {
      if (!fs.statSync(full).isDirectory()) continue
      const children = fs.readdirSync(full)
      if (children.length === 1 && children[0] === "skills") {
        fs.rmSync(full, { recursive: true, force: true })
        removed++
      }
    } catch { /* skip entries we can't stat */ }
  }
  if (removed > 0) {
    console.log(`  ✓ Cleaned up ${removed} IDE skill folders`)
  }
}

function collectSkillPaths(cwd: string, skillName: string, paths: string[]): void {
  for (const dir of [".claude/skills", ".agents/skills"]) {
    const skillPath = path.join(dir, skillName)
    if (fs.existsSync(path.join(cwd, skillPath))) {
      paths.push(skillPath)
    }
  }
}

export async function bootstrapCommand(opts: { force: boolean; provider?: string; model?: string }, pkgRoot: string) {
  const cwd = process.cwd()
  setConfigDir(cwd)
  const issueNumber = parseInt(process.env.ISSUE_NUMBER ?? "", 10) || 0
  const config = getProjectConfig()
  const bootstrapStageConfig = {
    ...resolveStageConfig(config, "bootstrap", "cheap"),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  }
  const bootstrapModel = bootstrapStageConfig.model
  let litellmProcess: ChildProcess | null = null
  const llmErrors: string[] = []
  console.log(`\n🔧 Kody Bootstrap — Generating project memory + step files\n`)
  console.log(`  Model: ${bootstrapModel} (provider: ${bootstrapStageConfig.provider})`)

  if (issueNumber) {
    ghComment(issueNumber, "🔧 **Bootstrap started** — analyzing project and generating configuration...", cwd)
  }

  // ── Start LiteLLM proxy if needed ──
  if (stageNeedsProxy(bootstrapStageConfig)) {
    const litellmUrl = getLitellmUrl()
    const isHealthy = await checkLitellmHealth(litellmUrl)
    if (!isHealthy) {
      const generatedConfig = generateLitellmConfig(bootstrapStageConfig.provider, config.agent.modelMap)
      console.log(`  Starting LiteLLM proxy for ${bootstrapStageConfig.provider}...`)
      litellmProcess = await tryStartLitellm(litellmUrl, cwd, generatedConfig)
      if (litellmProcess) {
        console.log(`  LiteLLM proxy started`)
      } else {
        console.warn(`  ⚠ LiteLLM proxy failed to start — LLM calls will fail`)
      }
    }
    process.env.ANTHROPIC_BASE_URL = litellmUrl
    process.env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  // ── Gather project context (repoContext used by step files + QA guide) ──
  const readIfExists = (rel: string, maxChars = 3000) => {
    const p = path.join(cwd, rel)
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8").slice(0, maxChars)
    return null
  }

  const pkgJson = readIfExists("package.json")

  // ── Step 1: Generate project memory (2 rounds) ──
  console.log("── Project Memory ──")
  const memoryDir = path.join(cwd, ".kody", "memory")
  fs.mkdirSync(memoryDir, { recursive: true })
  const archPath = path.join(memoryDir, "architecture.md")

  // ── Round 1: Architecture (solo, focused structural context) ──
  console.log("  Round 1: Architecture...")
  const archContext = gatherArchitectureContext(cwd)
  const existingArch = fs.existsSync(archPath) ? fs.readFileSync(archPath, "utf-8") : ""
  const archExtend = existingArch && !opts.force
    ? buildExtendInstruction(existingArch, "architecture document")
    : ""

  const archPrompt = `You are analyzing a project to generate an architecture document for an autonomous SDLC pipeline.

Given this project context, output a markdown document.

Rules:
- Be specific about THIS project
- Include: framework, language, database, testing framework, key directories, data flow
- Reference CLAUDE.md and .ai-docs/ if they exist
- Document the module/layer structure (e.g., controllers → services → repositories)
- Note infrastructure details (Docker, CI, deployment)
- Keep under 60 lines
${archExtend}
Output ONLY the markdown. No fences. No explanation.

${archContext}`

  let archContent = ""
  try {
    const output = execFileSync("claude", [
      "--print",
      "--model", bootstrapModel,
      "--dangerously-skip-permissions",
      archPrompt,
    ], {
      encoding: "utf-8",
      timeout: 300_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()

    archContent = output.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "")
    fs.writeFileSync(archPath, archContent)
    const lineCount = archContent.split("\n").length
    console.log(`  ✓ .kody/memory/architecture.md (${lineCount} lines)`)
  } catch (llmErr) {
    const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr)
    console.log("  ⚠ Architecture LLM call failed — using basic detection")
    llmErrors.push(`Architecture generation: ${errMsg}`)
    const detected = detectArchitectureBasic(cwd)
    if (detected.length > 0) {
      const timestamp = new Date().toISOString().slice(0, 10)
      archContent = `# Architecture (auto-detected ${timestamp})\n\n## Overview\n${detected.join("\n")}\n`
      fs.writeFileSync(archPath, archContent)
      console.log(`  ✓ .kody/memory/architecture.md (${detected.length} items, basic detection)`)
    }
  }

  // ── Round 2: Conventions + Patterns + Domain + Testing (parallel) ──
  console.log("  Round 2: Generating 4 memory files in parallel...")
  const round2Promises = ROUND2_TASKS.map(async (task) => {
    const filePath = path.join(memoryDir, `${task.name}.md`)
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : ""
    const extendBlock = existing && !opts.force
      ? buildExtendInstruction(existing, `${task.name} document`)
      : ""

    const context = task.gatherContext(cwd)
    const prompt = `You are analyzing a project to generate a ${task.name} document for an autonomous SDLC pipeline.

## Project Architecture (already analyzed)
${archContent || "(not available)"}

## Targeted Context
${context}

${task.promptRules}
${extendBlock}
Output ONLY the markdown. No fences. No explanation.`

    const output = await execClaudeAsync(prompt, bootstrapModel, cwd, 90_000)
    const cleaned = output.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "")

    if (!cleaned || cleaned.length < 20) {
      throw new Error("LLM returned empty or too-short output")
    }

    return { name: task.name, content: cleaned, filePath }
  })

  const round2Results = await Promise.allSettled(round2Promises)
  for (let i = 0; i < round2Results.length; i++) {
    const result = round2Results[i]
    const taskName = ROUND2_TASKS[i].name
    if (result.status === "fulfilled") {
      fs.writeFileSync(result.value.filePath, result.value.content)
      const lineCount = result.value.content.split("\n").length
      console.log(`  ✓ .kody/memory/${taskName}.md (${lineCount} lines)`)
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason)
      console.log(`  ✗ .kody/memory/${taskName}.md — ${errMsg}`)
      llmErrors.push(`${taskName}: ${errMsg}`)
    }
  }

  // ── Step 2: Generate step files via LLM ──
  console.log("\n── Step Files ──")
  const stepsDir = path.join(cwd, ".kody", "steps")
  fs.mkdirSync(stepsDir, { recursive: true })

  // Read all generated memory as unified context for step files and QA guide
  const projectMemory = readProjectMemory(cwd)

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

## Project Memory (architecture, conventions, patterns, domain, testing)
${projectMemory}

REMINDER: Output the full prompt template first (unchanged), then your three appended sections. Do NOT include "${contextPlaceholder}".`

    try {
      const output = execFileSync("claude", [
        "--print",
        "--model", bootstrapModel,
        "--dangerously-skip-permissions",
        customizationPrompt,
      ], {
        encoding: "utf-8",
        timeout: 300_000,
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
    } catch (stepErr) {
      const errMsg = stepErr instanceof Error ? stepErr.message : String(stepErr)
      if (!isExtend) {
        console.log(`  ⚠ ${stage}.md — customization failed, using default template`)
        fs.copyFileSync(templatePath, stepOutputPath)
        stepCount++
      } else {
        console.log(`  ⚠ ${stage}.md — extend failed, keeping existing`)
      }
      llmErrors.push(`Step ${stage}: ${errMsg}`)
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

## Project Memory
${projectMemory}
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
        timeout: 300_000,
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

  // ── Step 2c: Setup Kody Watch activity log ──
  console.log("\n── Kody Watch ──")
  const kodyConfigPath = path.join(cwd, "kody.config.json")
  if (fs.existsSync(kodyConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(kodyConfigPath, "utf-8"))
      if (config.watch?.enabled) {
        let watchRepoSlug = ""
        if (config.github?.owner && config.github?.repo) {
          watchRepoSlug = `${config.github.owner}/${config.github.repo}`
        }

        if (watchRepoSlug) {
          const ghOpts = { cwd, encoding: "utf-8" as const, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] }

          const gateway: ActivityLogGateway = {
            getIssueState(issueNum) {
              return execFileSync("gh", [
                "issue", "view", String(issueNum),
                "--repo", watchRepoSlug,
                "--json", "state", "--jq", ".state",
              ], ghOpts).trim()
            },
            getVariable() {
              try {
                return execFileSync("gh", [
                  "variable", "get", "WATCH_ACTIVITY_LOG",
                  "--repo", watchRepoSlug,
                ], ghOpts).trim() || null
              } catch { return null }
            },
            searchIssue() {
              try {
                const r = execFileSync("gh", [
                  "issue", "list", "--repo", watchRepoSlug,
                  "--search", "[Kody Watcher] Activity Log in:title",
                  "--state", "open", "--json", "number", "--jq", ".[0].number",
                ], { ...ghOpts, timeout: 15_000 }).trim()
                return r && !isNaN(parseInt(r, 10)) ? parseInt(r, 10) : null
              } catch { return null }
            },
            createIssue() {
              try {
                const url = execFileSync("gh", [
                  "issue", "create", "--repo", watchRepoSlug,
                  "--title", "[Kody Watcher] Activity Log",
                  "--body", "This issue receives periodic health reports from Kody Watch.\n\n**Plugins:** pipeline-health, security-scan, config-health\n\n_Do not close this issue — Kody Watch posts activity log comments here._",
                ], { ...ghOpts, timeout: 15_000 }).trim()
                const m = url.match(/\/issues\/(\d+)/)
                return m ? parseInt(m[1], 10) : null
              } catch { return null }
            },
            pinIssue(issueNum) {
              try {
                execFileSync("gh", [
                  "issue", "pin", String(issueNum), "--repo", watchRepoSlug,
                ], ghOpts)
              } catch { /* best-effort */ }
            },
          }

          const result = resolveActivityLog(config.watch?.activityLog, gateway)

          for (const w of result.warnings) console.log(`  ⚠ ${w}`)
          if (result.issueNumber && result.source) {
            const labels: Record<string, string> = {
              config: "Activity log from config",
              variable: "Activity log from variable",
              search: "Found existing activity log",
              created: "Created activity log",
            }
            console.log(`  ✓ ${labels[result.source]}: #${result.issueNumber}`)
            if (result.source === "created") console.log(`  ✓ Pinned activity log`)
          }

          // Persist to config and GitHub Actions variable
          if (result.issueNumber) {
            config.watch.activityLog = result.issueNumber
            fs.writeFileSync(kodyConfigPath, JSON.stringify(config, null, 2) + "\n")
            try {
              execFileSync("gh", [
                "variable", "set", "WATCH_ACTIVITY_LOG",
                "--repo", watchRepoSlug,
                "--body", String(result.issueNumber),
              ], { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] })
              console.log(`  ✓ Set WATCH_ACTIVITY_LOG variable`)
            } catch { /* best-effort */ }
          }
        }
      } else {
        console.log("  ○ Watch not enabled — skipping activity log setup")
      }
    } catch { /* config parse error */ }
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
        { name: "kody:success", color: "0e8a16", description: "Kody pipeline completed successfully" },
        { name: "kody:waiting", color: "fef2c0", description: "Kody is waiting for answers" },
        { name: "kody:paused", color: "fef2c0", description: "Kody pipeline paused — awaiting approval" },
        { name: "kody:low", color: "bfdadc", description: "Low complexity — skip plan/review" },
        { name: "kody:medium", color: "c5def5", description: "Medium complexity — skip review-fix" },
        { name: "kody:high", color: "d4c5f9", description: "High complexity — full pipeline" },
        { name: "kody:feature", color: "0e8a16", description: "New feature" },
        { name: "kody:bugfix", color: "d93f0b", description: "Bug fix" },
        { name: "kody:refactor", color: "fbca04", description: "Code refactoring" },
        { name: "kody:docs", color: "0075ca", description: "Documentation" },
        { name: "kody:chore", color: "e4e669", description: "Maintenance task" },
        { name: "kody:release", color: "0e8a16", description: "Release PR" },
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
      const entries = detected.map((t) => {
        const base = `${t.name}:\n  detect: ${JSON.stringify(t.detect)}\n  stages: ${JSON.stringify(t.stages)}\n  setup: "${t.setup}"\n  skill: "${t.skill}"`
        const run = t.run ? `\n  run: "${t.run}"` : ""
        return base + run
      }).join("\n\n")
      fs.writeFileSync(toolsYmlPath, `${header}\n${entries}\n`)
      for (const t of detected) console.log(`  ✓ ${t.name} detected`)
    } else {
      const example = `${header}#\n# Example:\n# playwright:\n#   detect: ["playwright.config.ts", "playwright.config.js"]\n#   stages: [verify]\n#   setup: "npx playwright install --with-deps chromium"\n#   skill: "microsoft/playwright-cli@playwright-cli"\n#   run: "npx playwright test"\n`
      fs.writeFileSync(toolsYmlPath, example)
      console.log("  ○ No tools detected — template created")
    }
  } else {
    console.log("  ○ .kody/tools.yml (already exists, keeping)")
  }

  // ── Step 3c: Generate folder-scoped sub-agents ──
  console.log("\n── Folder-Scoped Sub-Agents ──")
  const subAgentsResult = generateSubAgentsYml(cwd, opts.force)
  if (subAgentsResult.skipped) {
    console.log("  ○ No folder structure detected — skipping sub-agents generation")
  } else {
    const existingNote = subAgentsResult.existing > 0 ? ` (${subAgentsResult.existing} user overrides preserved)` : ""
    console.log(`  ✓ .kody/sub-agents.yml generated (${subAgentsResult.generated} agents)${existingNote}`)
  }

  // ── Step 3d: Install skills ──
  console.log("\n── Skills ──")
  const installedSkillPaths: string[] = []

  // Build exclude set: already installed + tool skills (installed separately at runtime)
  const excludeSkills = new Set<string>()

  // Already installed skills
  const claudeSkillsDir = path.join(cwd, ".claude", "skills")
  if (fs.existsSync(claudeSkillsDir)) {
    try {
      for (const entry of fs.readdirSync(claudeSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) excludeSkills.add(entry.name)
      }
    } catch { /* ignore */ }
  }

  // Tool skills (will be installed by runToolSetup at pipeline runtime)
  for (const tool of detectToolsForBootstrap(cwd)) {
    if (tool.skill) {
      const toolSkillName = tool.skill.split("@").pop() ?? ""
      excludeSkills.add(toolSkillName)
    }
  }

  // Install tool skills first (explicit from tools.yml)
  for (const tool of detectToolsForBootstrap(cwd)) {
    if (!tool.skill) continue
    const skillName = tool.skill.split("@").pop() ?? ""
    if (excludeSkills.has(skillName) && fs.existsSync(path.join(claudeSkillsDir, skillName))) continue
    try {
      console.log(`  Installing: ${tool.name} CLI (${tool.skill})`)
      execFileSync("npx", ["skills", "add", tool.skill, "--yes"], {
        cwd,
        encoding: "utf-8",
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      collectSkillPaths(cwd, skillName, installedSkillPaths)
      excludeSkills.add(skillName)
      console.log(`  ✓ ${tool.name} CLI`)
    } catch {
      console.log(`  ✗ ${tool.name} CLI — failed to install`)
    }
  }

  // Search skills.sh for project-relevant skills
  const keywords = detectProjectKeywords(cwd)
  if (keywords.length > 0) {
    console.log(`  Searching skills.sh for: ${keywords.join(", ")}`)
    const found = searchSkills(keywords, excludeSkills, 10)
    if (found.length > 0) {
      // Deterministic relevance filter: match skill names against project dependencies
      // Read full package.json (pkgJson may be truncated at 3000 chars for LLM context)
      const fullPkgJson = fs.existsSync(path.join(cwd, "package.json"))
        ? fs.readFileSync(path.join(cwd, "package.json"), "utf-8")
        : pkgJson
      const { kept: skillsToInstall, rejected } = filterSkillsByDependencies(found, fullPkgJson)
      for (const r of rejected) {
        console.log(`  ✗ ${r.name} — rejected (${r.reason})`)
      }
      if (rejected.length > 0) {
        console.log(`  ✓ Filtered: kept ${skillsToInstall.length}/${found.length} skills`)
      }

      for (const skill of skillsToInstall) {
        try {
          console.log(`  Installing: ${skill.name} (${skill.ref})`)
          execFileSync("npx", ["skills", "add", skill.ref, "--yes"], {
            cwd,
            encoding: "utf-8",
            timeout: 60_000,
            stdio: ["pipe", "pipe", "pipe"],
          })
          collectSkillPaths(cwd, skill.name, installedSkillPaths)
          console.log(`  ✓ ${skill.name}`)
        } catch {
          console.log(`  ✗ ${skill.name} — failed to install`)
        }
      }
    } else {
      console.log("  ○ No matching skills found on skills.sh")
    }
  } else {
    console.log("  ○ No frameworks detected — skipping skill search")
  }

  // Clean up IDE dot-folders created by `npx skills add`
  // The skills CLI scaffolds symlinks for every supported IDE, but we only use .claude and .agents
  cleanupIdeSkillDirs(cwd)

  // Add skills-lock.json if created
  if (fs.existsSync(path.join(cwd, "skills-lock.json"))) {
    installedSkillPaths.push("skills-lock.json")
  }

  // ── Step 4: Format, commit and push ──
  console.log("\n── Git ──")
  const filesToCommit = [
    ...MEMORY_FILES.map(f => `.kody/memory/${f}.md`),
    ".kody/qa-guide.md",
    ".kody/tools.yml",
    ".kody/sub-agents.yml",
    "kody.config.json",
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

  // ── Cleanup ──
  if (litellmProcess) {
    litellmProcess.kill("SIGTERM")
  }

  console.log("\n── Done ──")
  if (llmErrors.length > 0) {
    console.log(`  ⚠ Bootstrap completed with ${llmErrors.length} LLM error(s):`)
    for (const err of llmErrors) {
      console.log(`    • ${err}`)
    }
    if (issueNumber) {
      const errorList = llmErrors.map((e) => `- ${e}`).join("\n")
      ghComment(issueNumber, `⚠️ **Bootstrap completed with LLM errors** — some files used fallback templates instead of project-specific customization.\n\n**Errors:**\n${errorList}\n\nRe-run \`@kody bootstrap\` to retry.`, cwd)
    }
  } else {
    console.log("  ✓ Project bootstrap complete!")
    console.log("  Kody now has project-specific memory and customized step files.\n")
  }
}
