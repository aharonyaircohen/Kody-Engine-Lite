import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import { checkCommand, checkFile, checkGhAuth, checkGhRepoAccess, checkGhSecret } from "../health-checks.js"
import { detectBasicConfig, buildConfig } from "../config-detection.js"

export function initCommand(opts: { force: boolean }, pkgRoot: string) {
  const cwd = process.cwd()
  console.log(`\n🔧 Kody Engine Lite — Init\n`)
  console.log(`Project: ${cwd}\n`)

  // ── Step 1: Copy workflow + generate config ──
  console.log("── Files ──")
  const templatesDir = path.join(pkgRoot, "templates")
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

  // Config
  const configDest = path.join(cwd, "kody.config.json")
  if (!fs.existsSync(configDest) || opts.force) {
    const config = buildConfig(cwd, basic)
    fs.writeFileSync(configDest, JSON.stringify(config, null, 2) + "\n")
    console.log("  ✓ kody.config.json (auto-configured)")
  } else {
    console.log("  ○ kody.config.json (exists)")
  }

  // .gitignore cleanup
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
  const checks = [
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

  if (ghRepo.ok && ghRepo.detail) {
    const repoSlug = ghRepo.detail
    const secretChecks = [checkGhSecret(repoSlug, "ANTHROPIC_API_KEY")]
    for (const c of secretChecks) {
      console.log(c.ok ? `  ✓ ${c.name}` : `  ✗ ${c.name} — ${c.fix}`)
    }

    console.log("\n── Labels ──")
    console.log("  ○ Labels will be created automatically during bootstrap")
  }

  // ── Step 4: Validate config ──
  console.log("\n── Config ──")
  if (fs.existsSync(configDest)) {
    try {
      const config = JSON.parse(fs.readFileSync(configDest, "utf-8"))
      const configChecks = []

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

  // ── Step 5: Kody Watch (opt-in) ──
  console.log("\n── Kody Watch ──")
  const watchWorkflowSrc = path.join(templatesDir, "kody-watch.yml")
  const watchWorkflowDest = path.join(cwd, ".github", "workflows", "kody-watch.yml")
  if (fs.existsSync(watchWorkflowSrc)) {
    if (fs.existsSync(watchWorkflowDest) && !opts.force) {
      console.log("  ○ .github/workflows/kody-watch.yml (exists)")
    } else {
      // Install watch workflow + add config
      fs.mkdirSync(path.dirname(watchWorkflowDest), { recursive: true })
      fs.copyFileSync(watchWorkflowSrc, watchWorkflowDest)
      console.log("  ✓ .github/workflows/kody-watch.yml")

      // Add watch section to config
      if (fs.existsSync(configDest)) {
        try {
          const config = JSON.parse(fs.readFileSync(configDest, "utf-8"))
          if (!config.watch) {
            config.watch = { enabled: true }
            fs.writeFileSync(configDest, JSON.stringify(config, null, 2) + "\n")
            console.log("  ✓ Added watch config to kody.config.json")
          }
        } catch { /* config parse error */ }
      }

      console.log("  ℹ Kody Watch will monitor pipeline health every 30 minutes")
      console.log("  ℹ Activity log issue will be created during bootstrap")
    }

    // Install template watch agents
    const agentTemplatesDir = path.join(templatesDir, "watch-agents")
    const watchAgentsDir = path.join(cwd, ".kody", "watch", "agents")
    if (fs.existsSync(agentTemplatesDir)) {
      const agentDirs = fs.readdirSync(agentTemplatesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
      for (const agentDir of agentDirs) {
        const destDir = path.join(watchAgentsDir, agentDir.name)
        if (fs.existsSync(destDir) && !opts.force) {
          console.log(`  ○ .kody/watch/agents/${agentDir.name} (exists)`)
          continue
        }
        fs.mkdirSync(destDir, { recursive: true })
        const srcDir = path.join(agentTemplatesDir, agentDir.name)
        for (const file of fs.readdirSync(srcDir)) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file))
        }
        console.log(`  ✓ .kody/watch/agents/${agentDir.name}`)
      }

      // Copy watch agents README
      const readmeSrc = path.join(agentTemplatesDir, "README.md")
      if (fs.existsSync(readmeSrc)) {
        const readmeDest = path.join(watchAgentsDir, "README.md")
        if (!fs.existsSync(readmeDest) || opts.force) {
          fs.mkdirSync(watchAgentsDir, { recursive: true })
          fs.copyFileSync(readmeSrc, readmeDest)
          console.log("  ✓ .kody/watch/agents/README.md")
        }
      }
    }
  } else {
    console.log("  ○ kody-watch.yml template not found — skipping")
  }

  // ── Step 7: Install Kody skill ──
  console.log("\n── Kody Skill ──")
  const kodySkillSrc = path.join(templatesDir, "skills", "kody", "SKILL.md")
  const kodySkillDest = path.join(cwd, ".claude", "skills", "kody", "SKILL.md")
  if (fs.existsSync(kodySkillSrc)) {
    if (fs.existsSync(kodySkillDest) && !opts.force) {
      console.log("  ○ .claude/skills/kody/SKILL.md (exists)")
    } else {
      fs.mkdirSync(path.dirname(kodySkillDest), { recursive: true })
      fs.copyFileSync(kodySkillSrc, kodySkillDest)
      console.log("  ✓ .claude/skills/kody/SKILL.md")
    }
  } else {
    console.log("  ○ Kody skill template not found in package — skipping")
  }

  // ── Step 8: Format, commit and push ──
  console.log("\n── Git ──")
  const filesToCommit = [
    ".github/workflows/kody.yml",
    ".github/workflows/kody-watch.yml",
    ".claude/skills/kody/SKILL.md",
    "kody.config.json",
  ].filter((f) => fs.existsSync(path.join(cwd, f)))

  if (filesToCommit.length > 0) {
    try {
      const fullPaths = filesToCommit.map((f) => path.join(cwd, f))
      execFileSync("npx", ["prettier", "--write", ...fullPaths], {
        cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
      })
    } catch { /* Prettier not available */ }
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
