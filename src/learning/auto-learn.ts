import * as fs from "fs"
import * as path from "path"

import type { PipelineContext } from "../types.js"
import { logger } from "../logger.js"
import { detectArchitectureBasic } from "../bin/architecture-detection.js"

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

    // Auto-detect architecture (only if architecture.md doesn't exist)
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
  // Support both legacy "architecture.md" and new hall-prefixed "facts_architecture.md"
  const legacyPath = path.join(memoryDir, "architecture.md")
  const hallPath = path.join(memoryDir, "facts_architecture.md")
  if (fs.existsSync(legacyPath) || fs.existsSync(hallPath)) return

  const detected = detectArchitectureBasic(projectDir)
  if (detected.length > 0) {
    const content = `# Architecture (auto-detected ${timestamp})\n\n## Overview\n${detected.join("\n")}\n`
    fs.writeFileSync(hallPath, content)
    logger.info(`Auto-detected architecture (${detected.length} items)`)
  }
}
