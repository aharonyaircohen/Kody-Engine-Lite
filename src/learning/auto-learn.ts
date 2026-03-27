import * as fs from "fs"
import * as path from "path"

import type { PipelineContext } from "../types.js"
import { logger } from "../logger.js"

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

export function autoLearn(ctx: PipelineContext): void {
  try {
    const memoryDir = path.join(ctx.projectDir, ".kody", "memory")
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true })
    }

    const learnings: string[] = []
    const timestamp = new Date().toISOString().slice(0, 10)

    // Extract from verify.md (strip ANSI codes first)
    const verifyPath = path.join(ctx.taskDir, "verify.md")
    if (fs.existsSync(verifyPath)) {
      const verify = stripAnsi(fs.readFileSync(verifyPath, "utf-8"))
      if (/vitest/i.test(verify)) learnings.push("- Uses vitest for testing")
      if (/jest/i.test(verify)) learnings.push("- Uses jest for testing")
      if (/eslint/i.test(verify)) learnings.push("- Uses eslint for linting")
      if (/prettier/i.test(verify)) learnings.push("- Uses prettier for formatting")
      if (/tsc\b/i.test(verify)) learnings.push("- Uses TypeScript (tsc)")
      if (/jsdom/i.test(verify)) learnings.push("- Test environment: jsdom")
      if (/node/i.test(verify) && /environment/i.test(verify)) learnings.push("- Test environment: node")
    }

    // Extract from review.md
    const reviewPath = path.join(ctx.taskDir, "review.md")
    if (fs.existsSync(reviewPath)) {
      const review = fs.readFileSync(reviewPath, "utf-8")
      if (/\.js extension/i.test(review)) learnings.push("- Imports use .js extensions (ESM)")
      if (/barrel export/i.test(review)) learnings.push("- Uses barrel exports (index.ts)")
      if (/timezone/i.test(review)) learnings.push("- Timezone handling is a concern in this codebase")
      if (/UTC/i.test(review)) learnings.push("- Date operations should consider UTC vs local time")
    }

    // Extract from task.json
    const taskJsonPath = path.join(ctx.taskDir, "task.json")
    if (fs.existsSync(taskJsonPath)) {
      try {
        const raw = stripAnsi(fs.readFileSync(taskJsonPath, "utf-8"))
        const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
        const task = JSON.parse(cleaned)
        if (task.scope && Array.isArray(task.scope)) {
          const dirs = [...new Set(task.scope.map((s: string) => s.split("/").slice(0, -1).join("/")).filter(Boolean))]
          if (dirs.length > 0) learnings.push(`- Active directories: ${dirs.join(", ")}`)
        }
      } catch {
        // Ignore
      }
    }

    if (learnings.length > 0) {
      const conventionsPath = path.join(memoryDir, "conventions.md")
      const entry = `\n## Learned ${timestamp} (task: ${ctx.taskId})\n${learnings.join("\n")}\n`
      fs.appendFileSync(conventionsPath, entry)
      logger.info(`Auto-learned ${learnings.length} convention(s)`)
    }

    // Auto-detect architecture
    autoLearnArchitecture(ctx.projectDir, memoryDir, timestamp)
  } catch {
    // Auto-learn is best-effort — don't fail the pipeline
  }
}

function autoLearnArchitecture(
  projectDir: string,
  memoryDir: string,
  timestamp: string,
): void {
  const archPath = path.join(memoryDir, "architecture.md")

  // Only auto-detect if architecture.md doesn't exist yet
  if (fs.existsSync(archPath)) return

  const detected: string[] = []

  // Detect framework from package.json
  const pkgPath = path.join(projectDir, "package.json")
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

      // Frameworks
      if (allDeps.next) detected.push(`- Framework: Next.js ${allDeps.next}`)
      else if (allDeps.react) detected.push(`- Framework: React ${allDeps.react}`)
      else if (allDeps.express) detected.push(`- Framework: Express ${allDeps.express}`)
      else if (allDeps.fastify) detected.push(`- Framework: Fastify ${allDeps.fastify}`)

      // Language
      if (allDeps.typescript) detected.push(`- Language: TypeScript ${allDeps.typescript}`)

      // Testing
      if (allDeps.vitest) detected.push(`- Testing: vitest ${allDeps.vitest}`)
      else if (allDeps.jest) detected.push(`- Testing: jest ${allDeps.jest}`)

      // Linting
      if (allDeps.eslint) detected.push(`- Linting: eslint ${allDeps.eslint}`)

      // Database
      if (allDeps.prisma || allDeps["@prisma/client"]) detected.push("- Database: Prisma ORM")
      if (allDeps.drizzle || allDeps["drizzle-orm"]) detected.push("- Database: Drizzle ORM")
      if (allDeps.pg || allDeps.postgres) detected.push("- Database: PostgreSQL")

      // CMS
      if (allDeps.payload || allDeps["@payloadcms/next"]) detected.push(`- CMS: Payload CMS`)

      // Module type
      if (pkg.type === "module") detected.push("- Module system: ESM")
      else detected.push("- Module system: CommonJS")

      // Package manager
      if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) detected.push("- Package manager: pnpm")
      else if (fs.existsSync(path.join(projectDir, "yarn.lock"))) detected.push("- Package manager: yarn")
      else if (fs.existsSync(path.join(projectDir, "package-lock.json"))) detected.push("- Package manager: npm")
    } catch {
      // Ignore parse errors
    }
  }

  // Detect directory structure
  const topDirs: string[] = []
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        topDirs.push(entry.name)
      }
    }
    if (topDirs.length > 0) detected.push(`- Top-level directories: ${topDirs.join(", ")}`)
  } catch {
    // Ignore
  }

  // Detect src structure
  const srcDir = path.join(projectDir, "src")
  if (fs.existsSync(srcDir)) {
    try {
      const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true })
      const srcDirs = srcEntries.filter((e) => e.isDirectory()).map((e) => e.name)
      if (srcDirs.length > 0) detected.push(`- src/ structure: ${srcDirs.join(", ")}`)
    } catch {
      // Ignore
    }
  }

  if (detected.length > 0) {
    const content = `# Architecture (auto-detected ${timestamp})\n\n## Overview\n${detected.join("\n")}\n`
    fs.writeFileSync(archPath, content)
    logger.info(`Auto-detected architecture (${detected.length} items)`)
  }
}
