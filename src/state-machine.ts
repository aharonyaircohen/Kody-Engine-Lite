import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import type {
  StageName,
  StageDefinition,
  StageResult,
  StageState,
  PipelineStatus,
  PipelineContext,
} from "./types.js"
import { STAGES } from "./definitions.js"
import { buildFullPrompt, resolveModel } from "./context.js"
import { validateTaskJson, validatePlanMd, validateReviewMd } from "./validators.js"
import {
  ensureFeatureBranch,
  commitAll,
  pushBranch,
  getCurrentBranch,
  getDefaultBranch,
} from "./git-utils.js"
import {
  setLifecycleLabel,
  postComment,
  createPR,
} from "./github-api.js"
import { runQualityGates } from "./verify-runner.js"
import { getProjectConfig, FIX_COMMAND_TIMEOUT_MS } from "./config.js"
import { logger, ciGroup, ciGroupEnd } from "./logger.js"

// ─── State Management ────────────────────────────────────────────────────────

function loadState(taskId: string, taskDir: string): PipelineStatus | null {
  const p = path.join(taskDir, "status.json")
  if (!fs.existsSync(p)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"))
    if (raw.taskId === taskId) return raw as PipelineStatus
    return null
  } catch {
    return null
  }
}

function writeState(state: PipelineStatus, taskDir: string): void {
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(
    path.join(taskDir, "status.json"),
    JSON.stringify(state, null, 2),
  )
}

function initState(taskId: string): PipelineStatus {
  const stages = {} as Record<StageName, StageState>
  for (const stage of STAGES) {
    stages[stage.name] = { state: "pending", retries: 0 }
  }
  const now = new Date().toISOString()
  return { taskId, state: "running", stages, createdAt: now, updatedAt: now }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateStageOutput(
  stageName: string,
  content: string,
): { valid: boolean; error?: string } {
  switch (stageName) {
    case "taskify":
      return validateTaskJson(content)
    case "plan":
      return validatePlanMd(content)
    case "review":
      return validateReviewMd(content)
    default:
      return { valid: true }
  }
}

// ─── Stage Execution ─────────────────────────────────────────────────────────

async function executeAgentStage(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const prompt = buildFullPrompt(def.name, ctx.taskId, ctx.taskDir, ctx.projectDir, ctx.input.feedback)
  const model = resolveModel(def.modelTier, def.name)

  logger.info(`  model=${model} timeout=${def.timeout / 1000}s`)

  // Inject LiteLLM proxy URL if configured
  const config = getProjectConfig()
  const extraEnv: Record<string, string> = {}
  if (config.agent.litellmUrl) {
    extraEnv.ANTHROPIC_BASE_URL = config.agent.litellmUrl
  }

  const result = await ctx.runner.run(def.name, prompt, model, def.timeout, ctx.taskDir, {
    cwd: ctx.projectDir,
    env: extraEnv,
  })

  if (result.outcome !== "completed") {
    return { outcome: result.outcome, error: result.error, retries: 0 }
  }

  if (def.outputFile && result.output) {
    fs.writeFileSync(path.join(ctx.taskDir, def.outputFile), result.output)
  }

  // Variant file detection: if expected file missing, look for <base>-*<ext> variants
  if (def.outputFile) {
    const outputPath = path.join(ctx.taskDir, def.outputFile)
    if (!fs.existsSync(outputPath)) {
      const ext = path.extname(def.outputFile)
      const base = path.basename(def.outputFile, ext)
      const files = fs.readdirSync(ctx.taskDir)
      const variant = files.find(
        (f) => f.startsWith(base + "-") && f.endsWith(ext),
      )
      if (variant) {
        fs.renameSync(path.join(ctx.taskDir, variant), outputPath)
        logger.info(`  Renamed variant ${variant} → ${def.outputFile}`)
      }
    }
  }

  if (def.outputFile) {
    const outputPath = path.join(ctx.taskDir, def.outputFile)
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, "utf-8")
      const validation = validateStageOutput(def.name, content)
      if (!validation.valid) {
        logger.warn(`  validation warning: ${validation.error}`)
      }
    }
  }

  return { outcome: "completed", outputFile: def.outputFile, retries: 0 }
}

function executeGateStage(
  ctx: PipelineContext,
  def: StageDefinition,
): StageResult {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const verifyResult = runQualityGates(ctx.taskDir, ctx.projectDir)

  const lines: string[] = [
    `# Verification Report\n`,
    `## Result: ${verifyResult.pass ? "PASS" : "FAIL"}\n`,
  ]
  if (verifyResult.errors.length > 0) {
    lines.push(`\n## Errors\n`)
    for (const e of verifyResult.errors) {
      lines.push(`- ${e}\n`)
    }
  }
  if (verifyResult.summary.length > 0) {
    lines.push(`\n## Summary\n`)
    for (const s of verifyResult.summary) {
      lines.push(`- ${s}\n`)
    }
  }

  fs.writeFileSync(path.join(ctx.taskDir, "verify.md"), lines.join(""))

  return {
    outcome: verifyResult.pass ? "completed" : "failed",
    retries: 0,
  }
}

async function executeVerifyWithAutofix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  const maxAttempts = def.maxRetries ?? 2

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    logger.info(`  verification attempt ${attempt + 1}/${maxAttempts + 1}`)

    const gateResult = executeGateStage(ctx, def)
    if (gateResult.outcome === "completed") {
      return { ...gateResult, retries: attempt }
    }

    if (attempt < maxAttempts) {
      logger.info(`  verification failed, running fixes...`)
      const config = getProjectConfig()

      const runFix = (cmd: string) => {
        if (!cmd) return
        const parts = cmd.split(/\s+/)
        try {
          execFileSync(parts[0], parts.slice(1), {
            stdio: "pipe",
            timeout: FIX_COMMAND_TIMEOUT_MS,
          })
        } catch {
          // Silently ignore fix failures
        }
      }

      runFix(config.quality.lintFix)
      runFix(config.quality.formatFix)

      if (def.retryWithAgent) {
        logger.info(`  running ${def.retryWithAgent} agent...`)
        await executeAgentStage(ctx, {
          ...def,
          name: def.retryWithAgent as StageName,
          type: "agent",
          modelTier: "mid",
          timeout: 300_000,
          outputFile: undefined,
        })
      }
    }
  }

  return {
    outcome: "failed",
    retries: maxAttempts,
    error: "Verification failed after autofix attempts",
  }
}

async function executeReviewWithFix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  const reviewDef = STAGES.find((s) => s.name === "review")!
  const reviewFixDef = STAGES.find((s) => s.name === "review-fix")!

  const reviewResult = await executeAgentStage(ctx, reviewDef)
  if (reviewResult.outcome !== "completed") {
    return reviewResult
  }

  const reviewFile = path.join(ctx.taskDir, "review.md")
  if (!fs.existsSync(reviewFile)) {
    return { outcome: "failed", retries: 0, error: "review.md not found" }
  }

  const content = fs.readFileSync(reviewFile, "utf-8")
  const hasIssues = /\bfail\b/i.test(content) && !/pass/i.test(content)

  if (!hasIssues) {
    return reviewResult
  }

  logger.info(`  review found issues, running review-fix...`)
  const fixResult = await executeAgentStage(ctx, reviewFixDef)
  if (fixResult.outcome !== "completed") {
    return fixResult
  }

  logger.info(`  re-running review after fix...`)
  return executeAgentStage(ctx, reviewDef)
}

function executeShipStage(
  ctx: PipelineContext,
  _def: StageDefinition,
): StageResult {
  const shipPath = path.join(ctx.taskDir, "ship.md")

  // Local mode or no issue: skip git push + PR
  if (ctx.input.local && !ctx.input.issueNumber) {
    fs.writeFileSync(shipPath, "# Ship\n\nShip stage skipped — local mode, no issue number.\n")
    return { outcome: "completed", outputFile: "ship.md", retries: 0 }
  }

  try {
    const head = getCurrentBranch(ctx.projectDir)
    const base = getDefaultBranch(ctx.projectDir)

    // Push branch
    pushBranch(ctx.projectDir)

    // Resolve owner/repo
    const config = getProjectConfig()
    let owner = config.github?.owner
    let repo = config.github?.repo

    if (!owner || !repo) {
      try {
        const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
          encoding: "utf-8",
          cwd: ctx.projectDir,
        }).trim()
        const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
        if (match) {
          owner = match[1]
          repo = match[2]
        }
      } catch {
        // Can't determine repo
      }
    }

    // Derive PR title
    const taskMdPath = path.join(ctx.taskDir, "task.md")
    let title = "Update"
    if (fs.existsSync(taskMdPath)) {
      const content = fs.readFileSync(taskMdPath, "utf-8")
      const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"))
      title = (lines[0] ?? "Update").slice(0, 72)
    }

    // Create PR
    const closesLine = ctx.input.issueNumber ? `\n\nCloses #${ctx.input.issueNumber}` : ""
    const body = `Generated by Kody pipeline${closesLine}\n\n---\n🤖 Generated by Kody`
    const pr = createPR(head, base, title, body)

    if (pr) {
      // Post comment on issue
      if (ctx.input.issueNumber && !ctx.input.local) {
        try {
          postComment(ctx.input.issueNumber, `🎉 PR created: ${pr.url}`)
        } catch {
          // Fire and forget
        }
      }

      fs.writeFileSync(shipPath, `# Ship\n\nPR created: ${pr.url}\nPR #${pr.number}\n`)
    } else {
      fs.writeFileSync(shipPath, "# Ship\n\nPushed branch but failed to create PR.\n")
    }

    return { outcome: "completed", outputFile: "ship.md", retries: 0 }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fs.writeFileSync(shipPath, `# Ship\n\nFailed: ${msg}\n`)
    return { outcome: "failed", retries: 0, error: msg }
  }
}

// ─── Pipeline Loop ───────────────────────────────────────────────────────────

export async function runPipeline(ctx: PipelineContext): Promise<PipelineStatus> {
  let state = loadState(ctx.taskId, ctx.taskDir)

  if (!state) {
    state = initState(ctx.taskId)
    writeState(state, ctx.taskDir)
  }

  // Reset for rerun
  if (state.state !== "running") {
    state.state = "running"
    for (const stage of STAGES) {
      const s = state.stages[stage.name]
      if (s.state === "running" || s.state === "failed" || s.state === "timeout") {
        state.stages[stage.name] = { ...s, state: "pending" }
      }
    }
    writeState(state, ctx.taskDir)
  }

  const fromStage = ctx.input.fromStage
  let startExecution = !fromStage

  logger.info(`Pipeline started: ${ctx.taskId}`)
  logger.info(`Stages: ${STAGES.map((s) => s.name).join(" → ")}`)
  if (fromStage) logger.info(`Resuming from: ${fromStage}`)

  // Set initial lifecycle label
  if (ctx.input.issueNumber && !ctx.input.local) {
    const initialPhase = ctx.input.mode === "rerun" ? "building" : "planning"
    setLifecycleLabel(ctx.input.issueNumber, initialPhase)
  }

  // Ensure feature branch if issue number provided
  if (ctx.input.issueNumber && !ctx.input.dryRun) {
    try {
      const taskMdPath = path.join(ctx.taskDir, "task.md")
      const title = fs.existsSync(taskMdPath)
        ? fs.readFileSync(taskMdPath, "utf-8").split("\n")[0].slice(0, 50)
        : ctx.taskId
      ensureFeatureBranch(ctx.input.issueNumber, title, ctx.projectDir)
    } catch (err) {
      logger.warn(`  Failed to create feature branch: ${err}`)
    }
  }

  for (const def of STAGES) {
    // Handle fromStage skip logic
    if (!startExecution) {
      if (def.name === fromStage) {
        startExecution = true
      } else {
        continue
      }
    }

    if (state.stages[def.name].state === "completed") {
      logger.info(`[${def.name}] already completed, skipping`)
      continue
    }

    ciGroup(`Stage: ${def.name}`)

    state.stages[def.name] = {
      state: "running",
      startedAt: new Date().toISOString(),
      retries: 0,
    }
    writeState(state, ctx.taskDir)

    logger.info(`[${def.name}] starting...`)

    // Lifecycle labels at key transitions
    if (ctx.input.issueNumber && !ctx.input.local) {
      if (def.name === "build") setLifecycleLabel(ctx.input.issueNumber, "building")
      if (def.name === "review") setLifecycleLabel(ctx.input.issueNumber, "review")
    }

    let result: StageResult

    try {
      if (def.type === "agent") {
        if (def.name === "review") {
          result = await executeReviewWithFix(ctx, def)
        } else {
          result = await executeAgentStage(ctx, def)
        }
      } else if (def.type === "gate") {
        if (def.name === "verify") {
          result = await executeVerifyWithAutofix(ctx, def)
        } else {
          result = executeGateStage(ctx, def)
        }
      } else if (def.type === "deterministic") {
        result = executeShipStage(ctx, def)
      } else {
        result = { outcome: "failed", retries: 0, error: `Unknown stage type: ${def.type}` }
      }
    } catch (error) {
      result = {
        outcome: "failed",
        retries: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    ciGroupEnd()

    if (result.outcome === "completed") {
      state.stages[def.name] = {
        state: "completed",
        completedAt: new Date().toISOString(),
        retries: result.retries,
        outputFile: result.outputFile,
      }
      logger.info(`[${def.name}] ✓ completed`)

      // Git commit after code-modifying stages
      if (!ctx.input.dryRun && ctx.input.issueNumber) {
        if (def.name === "build") {
          try { commitAll(`feat(${ctx.taskId}): implement task`, ctx.projectDir) } catch { /* ignore */ }
        }
        if (def.name === "review-fix") {
          try { commitAll(`fix(${ctx.taskId}): address review`, ctx.projectDir) } catch { /* ignore */ }
        }
      }
    } else if (result.outcome === "timed_out") {
      state.stages[def.name] = {
        state: "timeout",
        retries: result.retries,
        error: "Stage timed out",
      }
      state.state = "failed"
      writeState(state, ctx.taskDir)
      logger.error(`[${def.name}] ⏱ timed out`)
      if (ctx.input.issueNumber && !ctx.input.local) {
        setLifecycleLabel(ctx.input.issueNumber, "failed")
      }
      break
    } else {
      state.stages[def.name] = {
        state: "failed",
        retries: result.retries,
        error: result.error ?? "Stage failed",
      }
      state.state = "failed"
      writeState(state, ctx.taskDir)
      logger.error(`[${def.name}] ✗ failed: ${result.error}`)
      if (ctx.input.issueNumber && !ctx.input.local) {
        setLifecycleLabel(ctx.input.issueNumber, "failed")
      }
      break
    }

    writeState(state, ctx.taskDir)
  }

  const allCompleted = STAGES.every(
    (s) => state.stages[s.name].state === "completed",
  )
  if (allCompleted) {
    state.state = "completed"
    writeState(state, ctx.taskDir)
    logger.info(`Pipeline completed: ${ctx.taskId}`)
    if (ctx.input.issueNumber && !ctx.input.local) {
      setLifecycleLabel(ctx.input.issueNumber, "done")
    }
    autoLearn(ctx)
  }

  return state
}

// ─── Auto-Learn ──────────────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

function autoLearn(ctx: PipelineContext): void {
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

export function printStatus(taskId: string, taskDir: string): void {
  const state = loadState(taskId, taskDir)
  if (!state) {
    console.log(`No status found for task ${taskId}`)
    return
  }

  console.log(`\nTask: ${state.taskId}`)
  console.log(`State: ${state.state}`)
  console.log(`Created: ${state.createdAt}`)
  console.log(`Updated: ${state.updatedAt}\n`)

  for (const stage of STAGES) {
    const s = state.stages[stage.name]
    const icon =
      s.state === "completed" ? "✓" :
      s.state === "failed" ? "✗" :
      s.state === "running" ? "▶" :
      s.state === "timeout" ? "⏱" : "○"
    const extra = s.error ? ` — ${s.error}` : ""
    console.log(`  ${icon} ${stage.name}: ${s.state}${extra}`)
  }
}
