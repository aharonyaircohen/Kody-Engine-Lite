import * as fs from "fs"
import * as path from "path"

import type {
  StageName,
  StageDefinition,
  StageResult,
  PipelineContext,
} from "../types.js"
import { buildFullPrompt, taskHasUI } from "../context.js"
import { validateTaskJson, validatePlanMd, validateReviewMd, stripFences } from "../validators.js"
import { getProjectConfig, resolveStageConfig, stageNeedsProxy, getLitellmUrl } from "../config.js"
import { buildMcpConfigJson, isMcpEnabledForStage, withPlaywrightIfNeeded } from "../mcp-config.js"
import { getRunnerForStage } from "../pipeline/runner-selection.js"
import { logger } from "../logger.js"

// ─── Session Groups ─────────────────────────────────────────────────────────
// Stages in the same group share a Claude Code session (warm context).
// Different groups get fresh sessions (clean perspective).

const SESSION_GROUP: Record<string, string> = {
  taskify: "explore",
  plan: "explore",
  build: "build",
  "review-fix": "build",
  review: "review",
}

function getSessionInfo(
  stageName: string,
  sessions: Record<string, string>,
): { sessionId: string; resumeSession: boolean } | undefined {
  const group = SESSION_GROUP[stageName]
  if (!group) return undefined

  const existing = sessions[group]
  if (existing) {
    return { sessionId: existing, resumeSession: true }
  }

  // Generate new session ID for this group
  const newId = crypto.randomUUID()
  sessions[group] = newId
  return { sessionId: newId, resumeSession: false }
}

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

export async function executeAgentStage(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const prompt = buildFullPrompt(def.name, ctx.taskId, ctx.taskDir, ctx.projectDir, ctx.input.feedback)

  if (ctx.input.feedback && def.name === "build") {
    logger.info(`  feedback: ${ctx.input.feedback.slice(0, 200)}${ctx.input.feedback.length > 200 ? "..." : ""}`)
  }

  const config = getProjectConfig()
  const sc = resolveStageConfig(config, def.name, def.modelTier)
  const model = sc.model
  const useProxy = stageNeedsProxy(sc)

  const runnerName =
    config.agent.stageRunners?.[def.name] ??
    config.agent.defaultRunner ??
    Object.keys(ctx.runners)[0] ?? "claude"

  logger.info(`  runner=${runnerName} provider=${sc.provider} model=${model} timeout=${def.timeout / 1000}s`)

  const extraEnv: Record<string, string> = {}
  if (useProxy) {
    extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
  }

  // Session management: stages in the same group share a Claude Code session
  const sessions = ctx.sessions ?? {}
  const sessionInfo = getSessionInfo(def.name, sessions)
  if (sessionInfo) {
    logger.info(`  session: ${SESSION_GROUP[def.name]} (${sessionInfo.resumeSession ? "resume" : "new"})`)
  }

  // MCP: pass server config if enabled for this stage
  // Auto-inject Playwright when the task involves UI
  const mcpForStage = isMcpEnabledForStage(def.name, config.mcp)
    ? withPlaywrightIfNeeded(config.mcp, taskHasUI(ctx.taskDir))
    : undefined
  const mcpConfigJson = buildMcpConfigJson(mcpForStage)
  if (mcpConfigJson) {
    logger.info(`  MCP servers enabled for ${def.name}`)
  }

  const runner = getRunnerForStage(ctx, def.name)
  const result = await runner.run(def.name, prompt, model, def.timeout, ctx.taskDir, {
    cwd: ctx.projectDir,
    env: extraEnv,
    ...sessionInfo,
    mcpConfigJson,
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
        // Taskify must produce valid JSON — retry once with stricter prompt
        if (def.name === "taskify") {
          logger.warn(`  taskify output invalid (${validation.error}), retrying...`)
          const retryPrompt = prompt + "\n\nIMPORTANT: Your previous output was not valid JSON. Output ONLY the raw JSON object. No markdown, no fences, no explanation."
          const retryResult = await runner.run(def.name, retryPrompt, model, def.timeout, ctx.taskDir, {
            cwd: ctx.projectDir,
            env: extraEnv,
          })
          if (retryResult.outcome === "completed" && retryResult.output) {
            const stripped = stripFences(retryResult.output)
            const retryValidation = validateTaskJson(stripped)
            if (retryValidation.valid) {
              fs.writeFileSync(outputPath, retryResult.output)
              logger.info(`  taskify retry produced valid JSON`)
            } else {
              logger.warn(`  taskify retry still invalid: ${retryValidation.error}`)
              // Fallback: generate a minimal valid task.json from the plain-text output.
              // This typically happens when the task already exists and the LLM
              // responds with a description instead of JSON.
              const plainText = content.trim()
              const fallback = JSON.stringify({
                task_type: "chore",
                title: plainText.slice(0, 72).replace(/\n/g, " "),
                description: plainText.slice(0, 500),
                scope: [],
                risk_level: "low",

                questions: [],
              }, null, 2)
              fs.writeFileSync(outputPath, fallback)
              logger.info(`  taskify fallback: generated minimal task.json (risk_level=low)`)
            }
          }
        } else {
          logger.warn(`  validation warning: ${validation.error}`)
        }
      }
    }
  }

  // Append stage summary to accumulated context
  appendStageContext(ctx.taskDir, def.name, result.output)

  return { outcome: "completed", outputFile: def.outputFile, retries: 0 }
}

function appendStageContext(taskDir: string, stageName: string, output?: string): void {
  const contextPath = path.join(taskDir, "context.md")
  const timestamp = new Date().toISOString().slice(0, 19)

  // Extract a summary from the output (first 500 chars, or note that it was tool-use only)
  let summary: string
  if (output && output.trim()) {
    summary = output.slice(0, 500)
    if (output.length > 500) summary += "\n...(truncated)"
  } else {
    summary = "(stage completed via tool use — no text output)"
  }

  const entry = `\n### ${stageName} (${timestamp})\n${summary}\n`
  fs.appendFileSync(contextPath, entry)
}
