/**
 * CLI entry point for @kody-ade/kody-engine-lite
 *
 * Commands:
 *   init     — Setup target repo: workflow, config, health check, architecture detection
 *   run      — Run the Kody pipeline (default when no command given)
 *   version  — Print package version
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

function checkEnvVar(varName: string, fix: string): CheckResult {
  const value = process.env[varName]
  if (value && value.length > 0) {
    return { name: varName, ok: true, detail: `set (${value.length} chars)` }
  }
  return { name: varName, ok: false, fix }
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
    const stderr = (err as { stderr?: string }).stderr ?? ""
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

// ─── Architecture detection ──────────────────────────────────────────────────

function detectArchitecture(cwd: string): string[] {
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
      else if (allDeps.mocha) detected.push(`- Testing: mocha ${allDeps.mocha}`)

      if (allDeps.eslint) detected.push(`- Linting: eslint ${allDeps.eslint}`)
      if (allDeps.prettier) detected.push(`- Formatting: prettier ${allDeps.prettier}`)
      if (allDeps.biome || allDeps["@biomejs/biome"]) detected.push("- Formatting: biome")

      if (allDeps.prisma || allDeps["@prisma/client"]) detected.push("- ORM: Prisma")
      if (allDeps["drizzle-orm"]) detected.push("- ORM: Drizzle")
      if (allDeps.pg || allDeps.postgres) detected.push("- Database: PostgreSQL")
      if (allDeps.mongodb || allDeps.mongoose) detected.push("- Database: MongoDB")
      if (allDeps.redis || allDeps.ioredis) detected.push("- Cache: Redis")

      if (allDeps.payload || allDeps["@payloadcms/next"]) detected.push("- CMS: Payload CMS")
      if (allDeps.tailwindcss) detected.push(`- CSS: Tailwind CSS ${allDeps.tailwindcss}`)

      if (pkg.type === "module") detected.push("- Module system: ESM")
      else detected.push("- Module system: CommonJS")

      if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) detected.push("- Package manager: pnpm")
      else if (fs.existsSync(path.join(cwd, "yarn.lock"))) detected.push("- Package manager: yarn")
      else if (fs.existsSync(path.join(cwd, "bun.lockb"))) detected.push("- Package manager: bun")
      else if (fs.existsSync(path.join(cwd, "package-lock.json"))) detected.push("- Package manager: npm")
    } catch {
      // Ignore parse errors
    }
  }

  // Directory structure
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
    if (dirs.length > 0) detected.push(`- Top-level directories: ${dirs.join(", ")}`)
  } catch { /* ignore */ }

  const srcDir = path.join(cwd, "src")
  if (fs.existsSync(srcDir)) {
    try {
      const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true })
      const srcDirs = srcEntries.filter((e) => e.isDirectory()).map((e) => e.name)
      if (srcDirs.length > 0) detected.push(`- src/ structure: ${srcDirs.join(", ")}`)
    } catch { /* ignore */ }
  }

  // Config files present
  const configs: string[] = []
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) configs.push("tsconfig.json")
  if (fs.existsSync(path.join(cwd, "docker-compose.yml")) || fs.existsSync(path.join(cwd, "docker-compose.yaml"))) configs.push("docker-compose")
  if (fs.existsSync(path.join(cwd, "Dockerfile"))) configs.push("Dockerfile")
  if (fs.existsSync(path.join(cwd, ".env")) || fs.existsSync(path.join(cwd, ".env.local"))) configs.push(".env")
  if (configs.length > 0) detected.push(`- Config files: ${configs.join(", ")}`)

  return detected
}

// ─── Smart config detection ─────────────────────────────────────────────────

function detectBasicConfig(cwd: string): { defaultBranch: string; owner: string; repo: string; pm: string; hasOpenCode: boolean } {
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

  const hasOpenCode = fs.existsSync(path.join(cwd, "opencode.json"))

  return { defaultBranch, owner, repo, pm, hasOpenCode }
}

function smartInit(cwd: string): {
  config: Record<string, unknown>
  architecture: string
  conventions: string
} {
  const basic = detectBasicConfig(cwd)

  // Gather project context for the LLM
  let context = ""
  const readIfExists = (rel: string, maxChars = 3000) => {
    const p = path.join(cwd, rel)
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8")
      return content.slice(0, maxChars)
    }
    return null
  }

  const pkgJson = readIfExists("package.json")
  if (pkgJson) context += `## package.json\n${pkgJson}\n\n`

  const tsconfig = readIfExists("tsconfig.json", 1000)
  if (tsconfig) context += `## tsconfig.json\n${tsconfig}\n\n`

  const readme = readIfExists("README.md", 2000)
  if (readme) context += `## README.md (first 2000 chars)\n${readme}\n\n`

  const claudeMd = readIfExists("CLAUDE.md", 3000)
  if (claudeMd) context += `## CLAUDE.md\n${claudeMd}\n\n`

  // List top-level dirs + src subdirs
  try {
    const topDirs = fs.readdirSync(cwd, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map(e => e.name)
    context += `## Top-level directories\n${topDirs.join(", ")}\n\n`

    const srcDir = path.join(cwd, "src")
    if (fs.existsSync(srcDir)) {
      const srcDirs = fs.readdirSync(srcDir, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name)
      context += `## src/ subdirectories\n${srcDirs.join(", ")}\n\n`
    }
  } catch { /* ignore */ }

  // Check for existing config files
  const existingFiles: string[] = []
  for (const f of [".env.example", "CLAUDE.md", ".ai-docs", "opencode.json", "vitest.config.ts", "vitest.config.mts", "jest.config.ts", "playwright.config.ts", ".eslintrc.js", "eslint.config.mjs", ".prettierrc"]) {
    if (fs.existsSync(path.join(cwd, f))) existingFiles.push(f)
  }
  if (existingFiles.length) context += `## Config files present\n${existingFiles.join(", ")}\n\n`

  context += `## Detected: package manager=${basic.pm}, default branch=${basic.defaultBranch}, github=${basic.owner}/${basic.repo}, opencode=${basic.hasOpenCode}\n`

  // Build prompt
  const prompt = `You are analyzing a project to configure Kody (an autonomous SDLC pipeline).

Given this project context, output ONLY a JSON object with EXACTLY this structure:

{
  "config": {
    "quality": {
      "typecheck": "${basic.pm} <script or command>",
      "lint": "${basic.pm} <script or command>",
      "lintFix": "${basic.pm} <script or command>",
      "format": "${basic.pm} <script or command>",
      "formatFix": "${basic.pm} <script or command>",
      "testUnit": "${basic.pm} <script or command>"
    },
    "git": { "defaultBranch": "${basic.defaultBranch}" },
    "github": { "owner": "${basic.owner}", "repo": "${basic.repo}" },
    "paths": { "taskDir": ".tasks" },
    "agent": {
      "runner": "${basic.hasOpenCode ? "opencode" : "claude-code"}",
      "defaultRunner": "${basic.hasOpenCode ? "opencode" : "claude"}",
      "modelMap": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" }
    }
  },
  "architecture": "# Architecture\\n\\n<markdown content>",
  "conventions": "# Conventions\\n\\n<markdown content>"
}

CRITICAL rules for config.quality:
- Every command MUST start with "${basic.pm}" (e.g., "${basic.pm} typecheck", "${basic.pm} lint")
- Look at the package.json "scripts" section to find the correct script names
- testUnit must run ONLY unit tests — exclude integration and e2e tests. If there's a "test:unit" script use it. Otherwise use "test" but add exclude flags for int/e2e.
- If a script doesn't exist and can't be inferred, set the value to ""
- Do NOT invent commands that don't exist in package.json scripts

Rules for architecture (markdown string):
- Be specific about THIS project
- Include: framework, language, database, testing, key directories, data flow
- Reference CLAUDE.md and .ai-docs/ if they exist
- Keep under 50 lines

Rules for conventions (markdown string):
- Extract actual patterns from the project
- If CLAUDE.md exists, reference it
- If .ai-docs/ exists, reference it
- Keep under 30 lines

Output ONLY valid JSON. No markdown fences. No explanation before or after.

${context}`

  console.log("  ⏳ Analyzing project with Claude Code...")

  try {
    const output = execFileSync("claude", [
      "--print",
      "--model", "haiku",
      "--dangerously-skip-permissions",
      prompt,
    ], {
      encoding: "utf-8",
      timeout: 120_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()

    // Parse JSON from output (strip markdown fences if present)
    const cleaned = output.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const parsed = JSON.parse(cleaned)

    // Merge with basic detected values (LLM might miss git/github)
    const config = parsed.config ?? {}
    if (!config.git) config.git = {}
    if (!config.github) config.github = {}
    if (!config.paths) config.paths = {}
    if (!config.agent) config.agent = {}

    config.git.defaultBranch = config.git.defaultBranch || basic.defaultBranch
    config.github.owner = config.github.owner || basic.owner
    config.github.repo = config.github.repo || basic.repo
    config.paths.taskDir = config.paths.taskDir || ".tasks"
    config.agent.runner = config.agent.runner || (basic.hasOpenCode ? "opencode" : "claude-code")
    config.agent.defaultRunner = config.agent.defaultRunner || (basic.hasOpenCode ? "opencode" : "claude")
    if (!config.agent.modelMap) {
      config.agent.modelMap = { cheap: "haiku", mid: "sonnet", strong: "opus" }
    }

    // Deterministic validation: override LLM choices with exact script matches
    validateQualityCommands(cwd, config, basic.pm)

    return {
      config,
      architecture: parsed.architecture ?? "",
      conventions: parsed.conventions ?? "",
    }
  } catch (err) {
    console.log("  ⚠ Smart detection failed, falling back to basic detection")
    // Fallback to basic heuristic config
    return {
      config: buildFallbackConfig(cwd, basic),
      architecture: "",
      conventions: "",
    }
  }
}

function validateQualityCommands(
  cwd: string,
  config: Record<string, unknown>,
  pm: string,
): void {
  let scripts: Record<string, string> = {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
    scripts = pkg.scripts ?? {}
  } catch { return }

  const quality = (config.quality ?? {}) as Record<string, string>

  // Prefer most specific script for each command
  const overrides: Array<{ key: string; preferred: string[]; }> = [
    { key: "typecheck", preferred: ["typecheck", "type-check"] },
    { key: "lint", preferred: ["lint"] },
    { key: "lintFix", preferred: ["lint:fix", "lint-fix"] },
    { key: "format", preferred: ["format:check", "format-check", "prettier:check"] },
    { key: "formatFix", preferred: ["format", "format:fix", "format-fix"] },
    { key: "testUnit", preferred: ["test:unit", "test-unit", "test:ci"] },
  ]

  for (const { key, preferred } of overrides) {
    // Find the best matching script from package.json
    const match = preferred.find((s) => scripts[s])
    if (match) {
      const correct = `${pm} ${match}`
      if (quality[key] !== correct) {
        quality[key] = correct
      }
    }
    // If the current value references a script that doesn't exist, clear it
    if (quality[key]) {
      const scriptName = quality[key].replace(`${pm} `, "")
      if (scriptName && !scripts[scriptName] && !scriptName.includes(" ")) {
        quality[key] = ""
      }
    }
  }

  config.quality = quality
}

function buildFallbackConfig(
  cwd: string,
  basic: { defaultBranch: string; owner: string; repo: string; pm: string; hasOpenCode: boolean },
): Record<string, unknown> {
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8")) } catch { return {} } })()
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  const find = (...c: string[]) => { for (const s of c) { if (scripts[s]) return `${basic.pm} ${s}` } return "" }

  return {
    quality: {
      typecheck: find("typecheck", "type-check") || (pkg.devDependencies?.typescript ? `${basic.pm} tsc --noEmit` : ""),
      lint: find("lint"),
      lintFix: find("lint:fix", "lint-fix"),
      format: find("format:check"),
      formatFix: find("format", "format:fix"),
      testUnit: find("test:unit", "test", "test:ci"),
    },
    git: { defaultBranch: basic.defaultBranch },
    github: { owner: basic.owner, repo: basic.repo },
    paths: { taskDir: ".tasks" },
    agent: {
      runner: basic.hasOpenCode ? "opencode" : "claude-code",
      defaultRunner: basic.hasOpenCode ? "opencode" : "claude",
      modelMap: { cheap: "haiku", mid: "sonnet", strong: "opus" },
    },
  }
}

// ─── init command ────────────────────────────────────────────────────────────

function initCommand(opts: { force: boolean }) {
  const cwd = process.cwd()
  console.log(`\n🔧 Kody Engine Lite — Init\n`)
  console.log(`Project: ${cwd}\n`)

  // ── Step 1: Copy files ──
  console.log("── Files ──")
  const templatesDir = path.join(PKG_ROOT, "templates")

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

  // Config — smart detection via LLM
  const configDest = path.join(cwd, "kody.config.json")
  let smartResult: { config: Record<string, unknown>; architecture: string; conventions: string } | null = null
  if (!fs.existsSync(configDest) || opts.force) {
    smartResult = smartInit(cwd)
    fs.writeFileSync(configDest, JSON.stringify(smartResult.config, null, 2) + "\n")
    console.log("  ✓ kody.config.json (auto-configured)")
  } else {
    console.log("  ○ kody.config.json (exists)")
  }

  // .gitignore
  const gitignorePath = path.join(cwd, ".gitignore")
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8")
    if (!content.includes(".tasks/")) {
      fs.appendFileSync(gitignorePath, "\n.tasks/\n")
      console.log("  ✓ .gitignore (added .tasks/)")
    } else {
      console.log("  ○ .gitignore (.tasks/ already present)")
    }
  }

  // ── Step 2: Health checks ──
  console.log("\n── Prerequisites ──")
  const checks: CheckResult[] = [
    checkCommand("claude", ["--version"], "Install: npm i -g @anthropic-ai/claude-code"),
    checkCommand("gh", ["--version"], "Install: https://cli.github.com"),
    checkCommand("git", ["--version"], "Install git"),
    checkCommand("node", ["--version"], "Install Node.js >= 22"),
    checkCommand("pnpm", ["--version"], "Install: npm i -g pnpm"),
    checkFile(path.join(cwd, "package.json"), "package.json", "Run: pnpm init"),
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

  // Check secrets and setup labels only if we can access the repo
  if (ghRepo.ok && ghRepo.detail) {
    const repoSlug = ghRepo.detail
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

    // Create lifecycle labels
    const labels = [
      { name: "kody:planning", color: "c5def5", description: "Kody is analyzing and planning" },
      { name: "kody:building", color: "0e8a16", description: "Kody is building code" },
      { name: "kody:review", color: "fbca04", description: "Kody is reviewing code" },
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

    console.log("\n── Labels ──")
    for (const label of labels) {
      try {
        execFileSync("gh", [
          "label", "create", label.name,
          "--repo", repoSlug,
          "--color", label.color,
          "--description", label.description,
          "--force",
        ], {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        })
        console.log(`  ✓ ${label.name}`)
      } catch {
        // Label may already exist or permission issue
        try {
          // Check if it exists
          execFileSync("gh", ["label", "list", "--repo", repoSlug, "--search", label.name], {
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
  }

  // ── Step 4: Validate kody.config.json ──
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

  // ── Step 5: Architecture detection ──
  console.log("\n── Project Memory ──")
  const memoryDir = path.join(cwd, ".kody", "memory")
  fs.mkdirSync(memoryDir, { recursive: true })
  const archPath = path.join(memoryDir, "architecture.md")
  const conventionsPath = path.join(memoryDir, "conventions.md")

  if (fs.existsSync(archPath) && !opts.force) {
    console.log("  ○ .kody/memory/architecture.md (exists, use --force to regenerate)")
  } else if (smartResult?.architecture) {
    fs.writeFileSync(archPath, smartResult.architecture)
    const lineCount = smartResult.architecture.split("\n").length
    console.log(`  ✓ .kody/memory/architecture.md (${lineCount} lines, LLM-generated)`)
  } else {
    // Fallback to basic detection
    const archItems = detectArchitecture(cwd)
    if (archItems.length > 0) {
      const timestamp = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(archPath, `# Architecture (auto-detected ${timestamp})\n\n## Overview\n${archItems.join("\n")}\n`)
      console.log(`  ✓ .kody/memory/architecture.md (${archItems.length} items, basic detection)`)
    } else {
      console.log("  ○ No architecture detected")
    }
  }

  if (fs.existsSync(conventionsPath) && !opts.force) {
    console.log("  ○ .kody/memory/conventions.md (exists, use --force to regenerate)")
  } else if (smartResult?.conventions) {
    fs.writeFileSync(conventionsPath, smartResult.conventions)
    const lineCount = smartResult.conventions.split("\n").length
    console.log(`  ✓ .kody/memory/conventions.md (${lineCount} lines, LLM-generated)`)
  } else {
    fs.writeFileSync(conventionsPath, "# Conventions\n\n<!-- Auto-learned conventions will be appended here -->\n")
    console.log("  ✓ .kody/memory/conventions.md (seed)")
  }

  // ── Summary ──
  const allChecks = [...checks, ghAuth, ghRepo]
  const failed = allChecks.filter((c) => !c.ok)

  console.log("\n── Summary ──")
  if (failed.length === 0) {
    console.log("  ✓ All checks passed! Ready to use.")
    console.log("\n  Next: Comment '@kody full <task-id>' on a GitHub issue")
  } else {
    console.log(`  ⚠ ${failed.length} issue(s) to fix:`)
    for (const c of failed) {
      console.log(`    • ${c.name}: ${c.fix}`)
    }
  }
  console.log("")
}

// ─── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]

if (command === "init") {
  initCommand({ force: args.includes("--force") })
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(getVersion())
} else {
  // Default: run the pipeline (import the entry module)
  import("../entry.js")
}
