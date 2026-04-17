import * as fs from "fs"
import * as path from "path"

import type {
  StageName,
  StageDefinition,
  StageResult,
  PipelineContext,
} from "../types.js"
import { buildFullPrompt, resolveModel, escalateModelTier, taskHasUI } from "../context.js"
import { estimateTokens } from "../context-tiers.js"
import { distillStageInsights, appendStageInsights } from "../stage-diary.js"
import { inferRoomsFromScope } from "../context-tiers.js"
import { validateTaskJson, validatePlanMd, validateReviewMd, stripFences } from "../validators.js"
import { getProjectConfig, resolveStageConfig, stageNeedsProxy, getLitellmUrl } from "../config.js"
import { buildMcpConfigJson, isMcpEnabledForStage } from "../mcp-config.js"
import { getRunnerForStage } from "../pipeline/runner-selection.js"
import { startDevServer, type DevServerHandle } from "../dev-server.js"
import { logger } from "../logger.js"
import { buildSubAgents } from "../sub-agents.js"

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

const FAILURE_CONTEXT_CHARS = 2000

function buildFailureContext(result: { outcome: string; output?: string; error?: string }): string {
  const parts: string[] = ["\n\n---\n## Previous Attempt Failed"]
  parts.push(`**Outcome:** ${result.outcome}`)

  const tail = result.output ?? result.error ?? ""
  if (tail.trim()) {
    const excerpt = tail.length > FAILURE_CONTEXT_CHARS ? tail.slice(-FAILURE_CONTEXT_CHARS) : tail
    parts.push(`**Last output (tail):**\n\`\`\`\n${excerpt}\n\`\`\``)
  }

  parts.push("Diagnose what went wrong above, then try a different approach. Do NOT repeat the same failing steps.")
  return parts.join("\n\n")
}

export async function executeAgentStage(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const prompt = buildFullPrompt(def.name, ctx.taskId, ctx.taskDir, ctx.projectDir, ctx.input.feedback, ctx.input.issueNumber)
  const promptTokens = estimateTokens(prompt)
  let currentModelTier: string = def.modelTier

  if (ctx.input.feedback && def.name === "build") {
    logger.info(`  feedback: ${ctx.input.feedback.slice(0, 200)}${ctx.input.feedback.length > 200 ? "..." : ""}`)
  }

  const config = getProjectConfig()
  const sc = resolveStageConfig(config, def.name, def.modelTier)
  let model = sc.model
  const useProxy = stageNeedsProxy(sc)
  const escalateEnabled = config.agent.escalateOnTimeout !== false
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
  const mcpForStage = isMcpEnabledForStage(def.name, config.mcp) ? config.mcp : undefined
  const mcpConfigJson = buildMcpConfigJson(mcpForStage)
  if (mcpConfigJson) {
    logger.info(`  MCP servers enabled for ${def.name}`)
  }

  // Dev server: start from engine process with hard timeout (not from Claude)
  // Decoupled from MCP — works with any provider (MCP or CLI-based tools like playwright-cli)
  const devServerStages = ["build", "review", "review-fix"]
  let devServerHandle: DevServerHandle | null = null
  const ds = config.devServer
  if (ds && devServerStages.includes(def.name) && taskHasUI(ctx.taskDir)) {
    logger.info(`  Starting dev server: ${ds.command}`)
    // Forward all process env vars to dev server (workflow exports all secrets dynamically).
    const envVars: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) envVars[k] = v
    }
    devServerHandle = await startDevServer({
      command: ds.command,
      url: ds.url,
      cwd: ctx.projectDir,
      readyTimeout: ds.readyTimeout ?? 180,
      readyPattern: ds.readyPattern ?? "Ready in|compiled|started server|Local:|localhost:",
      envVars,
    })
    if (devServerHandle.ready) {
      logger.info(`  Dev server ready at ${ds.url}`)
      extraEnv.KODY_DEV_SERVER_URL = ds.url
      extraEnv.KODY_DEV_SERVER_READY = "true"
    } else {
      logger.warn(`  Dev server not ready — Claude will work without browser verification`)
      extraEnv.KODY_DEV_SERVER_READY = "false"
    }
  }

  const runner = getRunnerForStage(ctx, def.name)
  const maxRetries = def.maxRetries ?? 0
  const subAgents = buildSubAgents(def.name, ctx.projectDir)

  let lastResult = await runner.run(def.name, prompt, model, def.timeout, ctx.taskDir, {
    cwd: ctx.projectDir,
    env: extraEnv,
    ...sessionInfo,
    mcpConfigJson,
    maxTurns: def.maxTurns,
    maxBudgetUsd: def.maxBudgetUsd,
    allowedTools: def.allowedTools,
    outputFormat: def.outputFormat,
    agents: subAgents,
    agentLogFile: path.join(ctx.taskDir, "logs", `${def.name}.log`),
  })

  let retries = 0
  while (lastResult.outcome !== "completed" && retries < maxRetries) {
    retries++
    const isTimeout = lastResult.outcome === "timed_out"

    if (isTimeout && escalateEnabled) {
      const nextTier = escalateModelTier(currentModelTier)
      if (nextTier !== currentModelTier) {
        logger.info(`  Escalating model from ${currentModelTier} to ${nextTier} after timeout`)
        currentModelTier = nextTier
        model = resolveModel(currentModelTier, def.name)
      }
    }

    // Build retry prompt with failure context so the agent doesn't repeat mistakes
    const failureContext = buildFailureContext(lastResult)
    const retryPrompt = prompt + failureContext

    // Discard the failed session so the retry gets a fresh one — Claude CLI rejects
    // resuming a session that was already marked as in-use by the failed attempt.
    delete sessions[SESSION_GROUP[def.name]]

    logger.info(`  retry ${retries}/${maxRetries} with model=${model}`)
    const retrySessionInfo = getSessionInfo(def.name, sessions)
    if (retrySessionInfo) {
      logger.info(`  session: ${SESSION_GROUP[def.name]} (fresh retry)`)
    }
    lastResult = await runner.run(def.name, retryPrompt, model, def.timeout, ctx.taskDir, {
      cwd: ctx.projectDir,
      env: extraEnv,
      ...retrySessionInfo,
      mcpConfigJson,
      maxTurns: def.maxTurns,
      maxBudgetUsd: def.maxBudgetUsd,
      allowedTools: def.allowedTools,
      outputFormat: def.outputFormat,
      agents: subAgents,
      agentLogFile: path.join(ctx.taskDir, "logs", `${def.name}.log`),
    })
  }

  // Clean up dev server
  if (devServerHandle) {
    devServerHandle.stop()
    logger.info(`  Dev server stopped`)
  }

  if (lastResult.outcome !== "completed") {
    return {
      outcome: lastResult.outcome,
      error: lastResult.error,
      retries,
      promptTokens,
      failureCategory: lastResult.failureCategory,
    }
  }

  const result = lastResult

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
            ...sessionInfo,
            mcpConfigJson,
            maxTurns: def.maxTurns,
            maxBudgetUsd: def.maxBudgetUsd,
            allowedTools: def.allowedTools,
            outputFormat: def.outputFormat,
            agentLogFile: path.join(ctx.taskDir, "logs", `${def.name}.log`),
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

  // Stage diary: distill reusable insights via LLM and persist to the graph.
  // Best-effort — never fails the stage.
  try {
    const insights = await distillStageInsights(def.name, ctx)
    if (insights.length > 0) {
      const room = inferRoomFromTask(ctx.taskDir)
      appendStageInsights(ctx, def.name, insights, room ?? undefined)
    }
  } catch (err) {
    logger.debug(
      `  stage-diary: post-stage hook error — ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  return { outcome: "completed", outputFile: def.outputFile, retries, promptTokens }
}

function inferRoomFromTask(taskDir: string): string | null {
  const taskJsonPath = path.join(taskDir, "task.json")
  if (!fs.existsSync(taskJsonPath)) return null
  try {
    const raw = fs.readFileSync(taskJsonPath, "utf-8")
    const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const task = JSON.parse(cleaned)
    const scope: string[] = Array.isArray(task.scope) ? task.scope : []
    const rooms = inferRoomsFromScope(scope)
    return rooms?.[0] ?? null
  } catch {
    return null
  }
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
