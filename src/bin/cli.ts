/**
 * CLI entry point for @kody-ade/kody-engine-lite
 *
 * Commands:
 *   init      — Setup target repo: workflow, config, labels, bootstrap issue
 *   bootstrap — Generate project memory + step files (runs in GH Actions)
 *   run       — Run the Kody pipeline (default when no command given)
 *   version   — Print package version
 */

import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..", "..")

function getVersion(): string {
  const pkgPath = path.join(PKG_ROOT, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
  return pkg.version
}

// ─── Health checks ───────────────────────────────────────────────────────────

interface CheckResult {
  name: string
  ok: boolean
  detail?: string
  fix?: string
}

function checkCommand(name: string, args: string[], fix: string): CheckResult {
  try {
    const output = execFileSync(name, args, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return { name: `${name} CLI`, ok: true, detail: output.split("\n")[0] }
  } catch {
    return { name: `${name} CLI`, ok: false, fix }
  }
}

function checkFile(filePath: string, description: string, fix: string): CheckResult {
  if (fs.existsSync(filePath)) {
    return { name: description, ok: true, detail: filePath }
  }
  return { name: description, ok: false, fix }
}

function checkGhAuth(cwd: string): CheckResult {
  try {
    const output = execFileSync("gh", ["auth", "status"], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const account = output.match(/Logged in to .* account (\S+)/)?.[1]
    return { name: "gh auth", ok: true, detail: account ?? "authenticated" }
  } catch (err) {
    const stderr = (err instanceof Error && "stderr" in err) ? String((err as Record<string, unknown>).stderr ?? "") : ""
    if (stderr.includes("not logged")) {
      return { name: "gh auth", ok: false, fix: "Run: gh auth login" }
    }
    return { name: "gh auth", ok: true, detail: "authenticated (partial check)" }
  }
}

function checkGhRepoAccess(cwd: string): CheckResult {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
    if (!match) {
      return { name: "GitHub repo", ok: false, fix: "Set git remote origin to a GitHub URL" }
    }
    const repoSlug = `${match[1]}/${match[2]}`

    // Check if we can access the repo via gh
    execFileSync("gh", ["repo", "view", repoSlug, "--json", "name"], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { name: "GitHub repo access", ok: true, detail: repoSlug }
  } catch {
    return { name: "GitHub repo access", ok: false, fix: "Verify gh auth and repo permissions" }
  }
}

function checkGhSecret(repoSlug: string, secretName: string): CheckResult {
  try {
    const output = execFileSync("gh", ["secret", "list", "--repo", repoSlug], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    if (output.includes(secretName)) {
      return { name: `Secret: ${secretName}`, ok: true, detail: "configured" }
    }
    return {
      name: `Secret: ${secretName}`,
      ok: false,
      fix: `Run: gh secret set ${secretName} --repo ${repoSlug}`,
    }
  } catch {
    return {
      name: `Secret: ${secretName}`,
      ok: false,
      fix: `Run: gh secret set ${secretName} --repo ${repoSlug} (or check permissions)`,
    }
  }
}

// ─── Deterministic config detection ─────────────────────────────────────────

function detectBasicConfig(cwd: string): { defaultBranch: string; owner: string; repo: string; pm: string } {
  // Package manager
  let pm = "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) pm = "yarn"
  else if (fs.existsSync(path.join(cwd, "bun.lockb"))) pm = "bun"
  else if (!fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) && fs.existsSync(path.join(cwd, "package-lock.json"))) pm = "npm"

  // Default branch
  let defaultBranch = "main"
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      encoding: "utf-8", timeout: 5_000, cwd, stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    defaultBranch = ref.replace("refs/remotes/origin/", "")
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/dev"], {
        encoding: "utf-8", timeout: 5_000, cwd, stdio: ["pipe", "pipe", "pipe"],
      })
      defaultBranch = "dev"
    } catch { /* keep main */ }
  }

  // GitHub owner/repo
  let owner = ""
  let repo = ""
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5_000, cwd, stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
    if (match) { owner = match[1]; repo = match[2] }
  } catch { /* ignore */ }

  return { defaultBranch, owner, repo, pm }
}

function buildConfig(cwd: string, basic: { defaultBranch: string; owner: string; repo: string; pm: string }): Record<string, unknown> {
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8")) } catch { return {} } })()
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  const find = (...c: string[]) => { for (const s of c) { if (scripts[s]) return `${basic.pm} ${s}` } return "" }

  const config: Record<string, unknown> = {
    "$schema": "https://raw.githubusercontent.com/aharonyaircohen/Kody-Engine-Lite/main/kody.config.schema.json",
    quality: {
      typecheck: find("typecheck", "type-check") || (pkg.devDependencies?.typescript ? `${basic.pm} tsc --noEmit` : ""),
      lint: find("lint"),
      lintFix: find("lint:fix", "lint-fix"),
      formatFix: find("format", "format:fix"),
      testUnit: find("test:unit", "test", "test:ci"),
    },
    git: { defaultBranch: basic.defaultBranch },
    github: { owner: basic.owner, repo: basic.repo },
    agent: {
      provider: "anthropic",
      modelMap: { cheap: "haiku", mid: "sonnet", strong: "opus" },
    },
  }

  // Auto-configure MCP for frontend projects
  const mcp = detectMcpConfig(cwd, basic.pm, pkg)
  if (mcp) config.mcp = mcp

  return config
}

const FRONTEND_DEPS = ["next", "react", "vue", "svelte", "nuxt", "astro", "solid-js", "angular", "@angular/core"]

function detectMcpConfig(
  cwd: string,
  pm: string,
  pkg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const allDeps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) }
  const hasFrontend = FRONTEND_DEPS.some((dep) => dep in allDeps)
  if (!hasFrontend) return undefined

  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  const hasDevScript = !!scripts.dev

  // Detect dev server port
  const isNext = "next" in allDeps || "nuxt" in allDeps
  const isVite = "vite" in allDeps
  const defaultPort = isNext ? 3000 : isVite ? 5173 : 3000

  const mcp: Record<string, unknown> = {
    enabled: true,
    servers: {},
    stages: ["build", "review"],
  }

  if (hasDevScript) {
    mcp.devServer = {
      command: `${pm} dev`,
      url: `http://localhost:${defaultPort}`,
    }
  }

  return mcp
}

// ─── init command ────────────────────────────────────────────────────────────

function initCommand(opts: { force: boolean }) {
  const cwd = process.cwd()
  console.log(`\n🔧 Kody Engine Lite — Init\n`)
  console.log(`Project: ${cwd}\n`)

  // ── Step 1: Copy workflow + generate config ──
  console.log("── Files ──")
  const templatesDir = path.join(PKG_ROOT, "templates")
  const basic = detectBasicConfig(cwd)

  // Workflow
  const workflowSrc = path.join(templatesDir, "kody.yml")
  const workflowDest = path.join(cwd, ".github", "workflows", "kody.yml")
  if (!fs.existsSync(workflowSrc)) {
    console.error("  ✗ Template kody.yml not found in package")
    process.exit(1)
  }
  if (fs.existsSync(workflowDest) && !opts.force) {
    console.log("  ○ .github/workflows/kody.yml (exists, use --force to overwrite)")
  } else {
    fs.mkdirSync(path.dirname(workflowDest), { recursive: true })
    fs.copyFileSync(workflowSrc, workflowDest)
    console.log("  ✓ .github/workflows/kody.yml")
  }

  // Config (deterministic — no LLM)
  const configDest = path.join(cwd, "kody.config.json")
  if (!fs.existsSync(configDest) || opts.force) {
    const config = buildConfig(cwd, basic)
    fs.writeFileSync(configDest, JSON.stringify(config, null, 2) + "\n")
    console.log("  ✓ kody.config.json (auto-configured)")
  } else {
    console.log("  ○ kody.config.json (exists)")
  }

  // .gitignore — remove legacy .tasks/ entry if present (tasks now live in .kody/tasks/ and are committed)
  const gitignorePath = path.join(cwd, ".gitignore")
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8")
    if (content.includes(".tasks/")) {
      const updated = content.replace(/\n?\.tasks\/\n?/g, "\n")
      fs.writeFileSync(gitignorePath, updated)
      console.log("  ✓ .gitignore (removed legacy .tasks/ — tasks now committed in .kody/tasks/)")
    } else {
      console.log("  ○ .gitignore (ok)")
    }
  }

  // ── Step 2: Health checks ──
  console.log("\n── Prerequisites ──")
  const checks: CheckResult[] = [
    checkCommand("gh", ["--version"], "Install: https://cli.github.com"),
    checkCommand("git", ["--version"], "Install git"),
    checkCommand("node", ["--version"], "Install Node.js >= 22"),
    checkFile(path.join(cwd, "package.json"), "package.json", `Run: ${basic.pm} init`),
  ]

  for (const c of checks) {
    if (c.ok) {
      console.log(`  ✓ ${c.name}${c.detail ? ` (${c.detail})` : ""}`)
    } else {
      console.log(`  ✗ ${c.name} — ${c.fix}`)
    }
  }

  // ── Step 3: GitHub checks ──
  console.log("\n── GitHub ──")
  const ghAuth = checkGhAuth(cwd)
  console.log(ghAuth.ok
    ? `  ✓ ${ghAuth.name} (${ghAuth.detail})`
    : `  ✗ ${ghAuth.name} — ${ghAuth.fix}`)

  const ghRepo = checkGhRepoAccess(cwd)
  console.log(ghRepo.ok
    ? `  ✓ ${ghRepo.name} (${ghRepo.detail})`
    : `  ✗ ${ghRepo.name} — ${ghRepo.fix}`)

  let repoSlug = ""
  if (ghRepo.ok && ghRepo.detail) {
    repoSlug = ghRepo.detail
    const secretChecks = [
      checkGhSecret(repoSlug, "ANTHROPIC_API_KEY"),
    ]
    for (const c of secretChecks) {
      if (c.ok) {
        console.log(`  ✓ ${c.name}`)
      } else {
        console.log(`  ✗ ${c.name} — ${c.fix}`)
      }
    }

    console.log("\n── Labels ──")
    console.log("  ○ Labels will be created automatically during bootstrap")
  }

  // ── Step 4: Validate config ──
  console.log("\n── Config ──")
  if (fs.existsSync(configDest)) {
    try {
      const config = JSON.parse(fs.readFileSync(configDest, "utf-8"))
      const configChecks: CheckResult[] = []

      if (config.github?.owner && config.github?.repo) {
        configChecks.push({ name: "github.owner/repo", ok: true, detail: `${config.github.owner}/${config.github.repo}` })
      } else {
        configChecks.push({ name: "github.owner/repo", ok: false, fix: "Edit kody.config.json: set github.owner and github.repo" })
      }

      if (config.git?.defaultBranch) {
        configChecks.push({ name: "git.defaultBranch", ok: true, detail: config.git.defaultBranch })
      }

      if (config.quality?.testUnit) {
        configChecks.push({ name: "quality.testUnit", ok: true, detail: config.quality.testUnit })
      } else {
        configChecks.push({ name: "quality.testUnit", ok: false, fix: "Edit kody.config.json: set quality.testUnit command" })
      }

      for (const c of configChecks) {
        if (c.ok) {
          console.log(`  ✓ ${c.name}${c.detail ? `: ${c.detail}` : ""}`)
        } else {
          console.log(`  ✗ ${c.name} — ${c.fix}`)
        }
      }
    } catch {
      console.log("  ✗ kody.config.json — invalid JSON")
    }
  }

  // ── Step 5: Format, commit and push ──
  console.log("\n── Git ──")
  const filesToCommit = [
    ".github/workflows/kody.yml",
    "kody.config.json",
  ].filter((f) => fs.existsSync(path.join(cwd, f)))

  // Format generated files with prettier if available
  if (filesToCommit.length > 0) {
    try {
      const fullPaths = filesToCommit.map((f) => path.join(cwd, f))
      execFileSync("npx", ["prettier", "--write", ...fullPaths], {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      // Prettier not available or failed — not critical
    }
  }

  if (filesToCommit.length > 0) {
    try {
      execFileSync("git", ["add", ...filesToCommit], { cwd, stdio: "pipe" })
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf-8" }).trim()
      if (staged) {
        execFileSync("git", ["commit", "-m", "chore: Add Kody Engine workflow and config\n\nAdd GitHub Actions workflow and auto-detected configuration for Kody Engine Lite."], { cwd, stdio: "pipe" })
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
    } catch (err) {
      console.log(`  ○ Git commit skipped: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ── Summary ──
  const allChecks = [...checks, ghAuth, ghRepo]
  const failed = allChecks.filter((c) => !c.ok)

  console.log("\n── Summary ──")
  if (failed.length === 0) {
    console.log("  ✓ All checks passed! Ready to use.")
    console.log(`
── Getting Started ──

  1. Bootstrap (optional but recommended):
     Create a GitHub issue comment with '@kody bootstrap'
     → Kody will analyze your repo and generate project-specific config

  2. First task:
     Create a GitHub issue describing work to do, then comment '@kody'
     → Kody picks it up and runs the full pipeline

  Commands:
     @kody               Run full pipeline on an issue
     @kody bootstrap     Analyze repo, generate memory + step files
     @kody fix           Fix build failures
     @kody review        Review a PR
`)
  } else {
    console.log(`  ⚠ ${failed.length} issue(s) to fix:`)
    for (const c of failed) {
      console.log(`    • ${c.name}: ${c.fix}`)
    }
    console.log("")
  }
}

// ─── bootstrap command ───────────────────────────────────────────────────────

const STEP_STAGES = ["taskify", "plan", "build", "autofix", "review", "review-fix"] as const

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

function bootstrapCommand(opts: { force: boolean } = { force: false }) {
  const cwd = process.cwd()
  const issueNumber = parseInt(process.env.ISSUE_NUMBER ?? "", 10) || 0
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
    ? `\n## Existing Documentation (EXTEND, do not replace)
You are UPDATING existing documentation. Follow these rules strictly:
- PRESERVE all existing sections and content that are still accurate
- REMOVE only lines that reference files, patterns, or dependencies that no longer exist in the project
- APPEND new sections or lines for newly discovered patterns, files, or conventions
- Do NOT rewrite sections that are still correct — keep them verbatim

### Existing architecture.md:
${existingArch}

### Existing conventions.md:
${existingConv}
`
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
      "--model", "haiku",
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
    const templatePath = path.join(PKG_ROOT, "prompts", `${stage}.md`)
    if (!fs.existsSync(templatePath)) {
      console.log(`  ✗ ${stage}.md — template not found in engine`)
      continue
    }

    const stepOutputPath = path.join(stepsDir, `${stage}.md`)

    // Skip if step file already exists (unless --force)
    if (fs.existsSync(stepOutputPath) && !opts.force) {
      console.log(`  ○ ${stage}.md — already exists (use --force to regenerate)`)
      continue
    }

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
        "--model", "haiku",
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
      console.log(`  ✓ ${stage}.md`)
    } catch {
      console.log(`  ⚠ ${stage}.md — customization failed, using default template`)
      fs.copyFileSync(templatePath, stepOutputPath)
      stepCount++
    }
  }
  console.log(`  ✓ Generated ${stepCount} step files in .kody/steps/`)

  // ── Step 2b: Generate QA guide ──
  console.log("\n── QA Guide ──")
  const qaGuidePath = path.join(cwd, ".kody", "qa-guide.md")
  if (!fs.existsSync(qaGuidePath) || opts.force) {
    const discovery = discoverQaContext(cwd)
    if (discovery.routes.length > 0) {
      const qaGuide = generateQaGuide(discovery)
      fs.writeFileSync(qaGuidePath, qaGuide)
      console.log(`  ✓ .kody/qa-guide.md (${discovery.routes.length} routes, ${discovery.roles.length} roles)`)
      if (discovery.loginPage) console.log(`  ✓ Login page detected: ${discovery.loginPage}`)
      if (discovery.adminPath) console.log(`  ✓ Admin panel detected: ${discovery.adminPath}`)
      console.log("  ℹ Add QA_ADMIN_EMAIL, QA_ADMIN_PASSWORD, QA_USER_EMAIL, QA_USER_PASSWORD as GitHub secrets")
    } else {
      console.log("  ○ No routes detected — skipping QA guide")
    }
  } else {
    console.log("  ○ .kody/qa-guide.md already exists (use --force to regenerate)")
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
        { name: "kody:planning", color: "c5def5", description: "Kody is analyzing and planning" },
        { name: "kody:building", color: "0e8a16", description: "Kody is building code" },
        { name: "kody:review", color: "fbca04", description: "Kody is reviewing code" },
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

  // ── Step 4: Install skills ──
  console.log("\n── Skills ──")
  const installedSkillPaths = installSkillsForProject(cwd)

  // ── Step 5: Format, commit and push ──
  console.log("\n── Git ──")
  const filesToCommit = [
    ".kody/memory/architecture.md",
    ".kody/memory/conventions.md",
    ".kody/qa-guide.md",
    ...installedSkillPaths,
  ].filter((f) => fs.existsSync(path.join(cwd, f)))

  // Add skills-lock.json if created
  if (fs.existsSync(path.join(cwd, "skills-lock.json"))) {
    filesToCommit.push("skills-lock.json")
  }

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

// ─── QA Guide Generation ─────────────────────────────────────────────────────

interface QaDiscovery {
  routes: { path: string; group: string }[]
  authFiles: string[]
  loginPage: string | null
  adminPath: string | null
  roles: string[]
  devCommand: string
  devPort: number
}

function discoverQaContext(cwd: string): QaDiscovery {
  const result: QaDiscovery = {
    routes: [],
    authFiles: [],
    loginPage: null,
    adminPath: null,
    roles: [],
    devCommand: "",
    devPort: 3000,
  }

  // Detect dev command and port
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const pm = fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) ? "pnpm"
      : fs.existsSync(path.join(cwd, "yarn.lock")) ? "yarn" : "npm"
    if (pkg.scripts?.dev) result.devCommand = `${pm} dev`
    if (allDeps.next || allDeps.nuxt) result.devPort = 3000
    else if (allDeps.vite) result.devPort = 5173
  } catch { /* ignore */ }

  // Scan for Next.js App Router routes
  const appDirs = ["src/app", "app"]
  for (const appDir of appDirs) {
    const fullAppDir = path.join(cwd, appDir)
    if (!fs.existsSync(fullAppDir)) continue
    scanRoutes(fullAppDir, appDir, "", result)
    break
  }

  // Detect auth-related files
  const authPatterns = ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"]
  for (const p of authPatterns) {
    if (fs.existsSync(path.join(cwd, p))) result.authFiles.push(p)
  }

  // Scan for auth config files
  const authConfigGlobs = [
    "src/app/api/auth", "src/auth", "src/lib/auth", "auth.config.ts", "auth.ts",
    "src/app/api/oauth",
  ]
  for (const g of authConfigGlobs) {
    if (fs.existsSync(path.join(cwd, g))) result.authFiles.push(g)
  }

  // Scan for role definitions in common locations
  try {
    const rolePaths = [
      "src/types", "src/lib", "src/utils", "src/constants",
      "src/access", "src/collections",
    ]
    for (const rp of rolePaths) {
      const dir = path.join(cwd, rp)
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(dir, f), "utf-8").slice(0, 5000)
          const roleMatches = content.match(/(?:role|Role|ROLE)\s*[=:]\s*['"](\w+)['"]/g)
          if (roleMatches) {
            for (const m of roleMatches) {
              const val = m.match(/['"](\w+)['"]/)
              if (val && !result.roles.includes(val[1])) result.roles.push(val[1])
            }
          }
          // Also check for enum-style roles
          const enumMatch = content.match(/(?:enum|type)\s+\w*[Rr]ole\w*\s*[={]([^}]+)/s)
          if (enumMatch) {
            const vals = enumMatch[1].match(/['"](\w+)['"]/g)
            if (vals) {
              for (const v of vals) {
                const clean = v.replace(/['"]/g, "")
                if (!result.roles.includes(clean)) result.roles.push(clean)
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return result
}

function scanRoutes(dir: string, baseDir: string, prefix: string, result: QaDiscovery): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return }

  // Check if this directory has a page file
  const hasPage = entries.some(e => e.isFile() && /^page\.(tsx?|jsx?)$/.test(e.name))
  if (hasPage) {
    const routePath = prefix || "/"
    // Determine route group
    const group = prefix.startsWith("/admin") ? "admin"
      : prefix.includes("/login") ? "auth"
      : prefix.includes("/signup") ? "auth"
      : prefix.includes("/api") ? "api"
      : "frontend"

    result.routes.push({ path: routePath, group })

    if (prefix.includes("/login")) result.loginPage = routePath
    if (prefix.startsWith("/admin") && !result.adminPath) result.adminPath = prefix
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === "node_modules" || entry.name === ".next") continue

    // Convert Next.js directory conventions to URL segments
    let segment = entry.name
    if (segment.startsWith("(") && segment.endsWith(")")) {
      // Route groups like (frontend), (payload) — don't add to URL
      scanRoutes(path.join(dir, entry.name), baseDir, prefix, result)
      continue
    }
    if (segment.startsWith("[") && segment.endsWith("]")) {
      segment = `:${segment.slice(1, -1)}`
    }
    if (segment.startsWith("[[") && segment.endsWith("]]")) {
      segment = `:${segment.slice(2, -2)}?`
    }

    scanRoutes(path.join(dir, entry.name), baseDir, `${prefix}/${segment}`, result)
  }
}

function generateQaGuide(discovery: QaDiscovery): string {
  const lines: string[] = ["# QA Guide", "", "## Authentication", ""]

  if (discovery.loginPage) {
    lines.push(`- Login page: \`${discovery.loginPage}\``)
  }

  lines.push(
    "",
    "### Test Accounts",
    "<!-- Fill in your test/preview environment credentials below -->",
    "| Role | Email | Password |",
    "|------|-------|----------|",
    "| Admin | admin@example.com | CHANGE_ME |",
    "| User | user@example.com | CHANGE_ME |",
    "",
    "### Login Steps",
    `1. Navigate to \`${discovery.loginPage ?? "/login"}\``,
    "2. Enter credentials from the test accounts table above",
    "3. Submit the login form",
    "4. Verify redirect to dashboard or home page",
  )

  if (discovery.authFiles.length > 0) {
    lines.push("", "### Auth Files")
    for (const f of discovery.authFiles) {
      lines.push(`- \`${f}\``)
    }
  }

  if (discovery.roles.length > 0) {
    lines.push("", "## Roles", "")
    for (const role of discovery.roles) {
      lines.push(`- \`${role}\``)
    }
  }

  lines.push("", "## Key Pages", "")

  // Group routes
  const groups: Record<string, string[]> = {}
  for (const route of discovery.routes) {
    if (!groups[route.group]) groups[route.group] = []
    groups[route.group].push(route.path)
  }

  for (const [group, routes] of Object.entries(groups)) {
    lines.push(`### ${group.charAt(0).toUpperCase() + group.slice(1)}`)
    // Show up to 20 routes per group, sorted
    const sorted = routes.sort()
    for (const r of sorted.slice(0, 20)) {
      lines.push(`- \`${r}\``)
    }
    if (sorted.length > 20) {
      lines.push(`- ... and ${sorted.length - 20} more`)
    }
    lines.push("")
  }

  lines.push(
    "## Dev Server",
    "",
    `- Command: \`${discovery.devCommand || "pnpm dev"}\``,
    `- URL: \`http://localhost:${discovery.devPort}\``,
    "",
  )

  return lines.join("\n")
}

// ─── Basic architecture detection (fallback, no LLM) ────────────────────────

function detectArchitectureBasic(cwd: string): string[] {
  const detected: string[] = []

  const pkgPath = path.join(cwd, "package.json")
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

      if (allDeps.next) detected.push(`- Framework: Next.js ${allDeps.next}`)
      else if (allDeps.react) detected.push(`- Framework: React ${allDeps.react}`)
      else if (allDeps.express) detected.push(`- Framework: Express ${allDeps.express}`)
      else if (allDeps.fastify) detected.push(`- Framework: Fastify ${allDeps.fastify}`)
      else if (allDeps.hono) detected.push(`- Framework: Hono ${allDeps.hono}`)

      if (allDeps.typescript) detected.push(`- Language: TypeScript ${allDeps.typescript}`)

      if (allDeps.vitest) detected.push(`- Testing: vitest ${allDeps.vitest}`)
      else if (allDeps.jest) detected.push(`- Testing: jest ${allDeps.jest}`)

      if (allDeps.eslint) detected.push(`- Linting: eslint ${allDeps.eslint}`)
      if (allDeps.prettier) detected.push(`- Formatting: prettier ${allDeps.prettier}`)

      if (allDeps.prisma || allDeps["@prisma/client"]) detected.push("- ORM: Prisma")
      if (allDeps["drizzle-orm"]) detected.push("- ORM: Drizzle")
      if (allDeps.payload || allDeps["@payloadcms/next"]) detected.push("- CMS: Payload CMS")
      if (allDeps.tailwindcss) detected.push(`- CSS: Tailwind CSS ${allDeps.tailwindcss}`)

      if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) detected.push("- Package manager: pnpm")
      else if (fs.existsSync(path.join(cwd, "yarn.lock"))) detected.push("- Package manager: yarn")
      else if (fs.existsSync(path.join(cwd, "bun.lockb"))) detected.push("- Package manager: bun")
      else if (fs.existsSync(path.join(cwd, "package-lock.json"))) detected.push("- Package manager: npm")
    } catch { /* ignore */ }
  }

  return detected
}

// ─── Skill auto-detection ────────────────────────────────────────────────────

interface SkillMapping {
  /** Skill package in owner/repo@skill format */
  package: string
  /** Human-readable label for logging */
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

function detectSkillsForProject(cwd: string): SkillMapping[] {
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

function installSkillsForProject(cwd: string): string[] {
  const skills = detectSkillsForProject(cwd)
  if (skills.length === 0) {
    console.log("  ○ No skills to install (no frontend framework detected)")
    return []
  }

  // Read existing skills-lock.json to skip already installed
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

    // Skip if already installed
    if (skillName in installedSkills) {
      console.log(`  ○ ${skill.label} — already installed`)
      // Still collect paths for git commit
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

      // Collect installed file paths for git
      const skillName = skill.package.split("@").pop() ?? ""
      const agentPath = `.agents/skills/${skillName}`
      const claudePath = `.claude/skills/${skillName}`
      if (fs.existsSync(path.join(cwd, agentPath))) installedPaths.push(agentPath)
      if (fs.existsSync(path.join(cwd, claudePath))) installedPaths.push(claudePath)

      console.log(`  ✓ ${skill.label}`)
    } catch (err) {
      console.log(`  ✗ ${skill.label} — failed to install`)
    }
  }

  return installedPaths
}

// ─── exports for testing ─────────────────────────────────────────────────────

export { detectBasicConfig, buildConfig, detectArchitectureBasic, detectSkillsForProject }
export { checkCommand, checkFile, checkGhAuth, checkGhRepoAccess, checkGhSecret }
export type { CheckResult }

// ─── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]

if (command === "init") {
  initCommand({ force: args.includes("--force") })
} else if (command === "bootstrap") {
  bootstrapCommand({ force: args.includes("--force") })
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(getVersion())
} else {
  // Default: run the pipeline (import the entry module)
  import("../entry.js")
}
