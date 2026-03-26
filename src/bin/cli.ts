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

  // Config
  const configDest = path.join(cwd, "kody.config.json")
  if (!fs.existsSync(configDest)) {
    const defaultConfig = {
      quality: {
        typecheck: "pnpm tsc --noEmit",
        lint: "",
        lintFix: "",
        format: "",
        formatFix: "",
        testUnit: "pnpm test",
      },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      paths: { taskDir: ".tasks" },
      agent: {
        runner: "claude-code",
        modelMap: { cheap: "haiku", mid: "sonnet", strong: "opus" },
      },
    }
    fs.writeFileSync(configDest, JSON.stringify(defaultConfig, null, 2) + "\n")
    console.log("  ✓ kody.config.json (created — edit github.owner and github.repo)")
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
  console.log("\n── Architecture Detection ──")
  const memoryDir = path.join(cwd, ".kody", "memory")
  const archPath = path.join(memoryDir, "architecture.md")

  if (fs.existsSync(archPath)) {
    console.log("  ○ .kody/memory/architecture.md (exists, not overwriting)")
  } else {
    const archItems = detectArchitecture(cwd)
    if (archItems.length > 0) {
      fs.mkdirSync(memoryDir, { recursive: true })
      const timestamp = new Date().toISOString().slice(0, 10)
      const content = `# Architecture (auto-detected ${timestamp})\n\n## Overview\n${archItems.join("\n")}\n`
      fs.writeFileSync(archPath, content)
      console.log(`  ✓ .kody/memory/architecture.md (${archItems.length} items detected)`)
      for (const item of archItems) {
        console.log(`    ${item}`)
      }
    } else {
      console.log("  ○ No architecture detected")
    }
  }

  // Create conventions.md seed if doesn't exist
  const conventionsPath = path.join(memoryDir, "conventions.md")
  if (!fs.existsSync(conventionsPath)) {
    fs.mkdirSync(memoryDir, { recursive: true })
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
