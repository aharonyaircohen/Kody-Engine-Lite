/**
 * `kody serve` — Start Kody infrastructure locally and launch Claude Code.
 *
 * Sets up the same environment that GH Actions gets:
 *   1. Reads kody.config.json
 *   2. Starts LiteLLM proxy (if non-Anthropic provider configured)
 *   3. Starts dev server (if configured)
 *   4. Launches Claude Code CLI with ANTHROPIC_BASE_URL pointed at LiteLLM
 *
 * Usage:
 *   kody-engine serve                  # uses kody.config.json in cwd
 *   kody-engine serve --cwd /path      # target a different project
 *   kody-engine serve --provider minimax --model MiniMax-M1
 *   kody-engine serve --no-claude      # start infra only, skip launching Claude Code
 */

import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"

import { logger } from "../../logger.js"
import {
  getProjectConfig,
  setConfigDir,
  applyModelOverrides,
  anyStageNeedsProxy,
  getLitellmUrl,
  getAnthropicApiKeyOrDummy,
} from "../../config.js"
import type { KodyConfig } from "../../config.js"
import {
  checkLitellmHealth,
  tryStartLitellm,
  generateLitellmConfig,
  generateLitellmConfigFromStages,
  checkModelHealth,
} from "../../cli/litellm.js"
import { startDevServer } from "../../dev-server.js"
import type { DevServerHandle } from "../../dev-server.js"
import { readProjectMemory } from "../../memory.js"
import { getArg } from "../cli.js"

interface ServeOptions {
  cwd?: string
  provider?: string
  model?: string
  noClaude?: boolean
}

function parseServeArgs(args: string[]): ServeOptions {
  return {
    cwd: getArg(args, "--cwd"),
    provider: getArg(args, "--provider"),
    model: getArg(args, "--model"),
    noClaude: args.includes("--no-claude"),
  }
}

async function ensureLitellmForServe(
  config: KodyConfig,
  projectDir: string,
): Promise<ReturnType<typeof spawn> | null> {
  if (!anyStageNeedsProxy(config)) return null

  const litellmUrl = getLitellmUrl()
  const proxyRunning = await checkLitellmHealth(litellmUrl)

  // Generate config from per-stage configs or legacy provider
  let generatedConfig: string | undefined
  if (config.agent.stages || config.agent.default) {
    generatedConfig = generateLitellmConfigFromStages(config.agent.default, config.agent.stages)
  } else if (config.agent.provider && config.agent.provider !== "anthropic") {
    generatedConfig = generateLitellmConfig(config.agent.provider, config.agent.modelMap)
  }

  if (proxyRunning) {
    logger.info(`LiteLLM proxy already running at ${litellmUrl}`)
    return null
  }

  const litellmProcess = await tryStartLitellm(litellmUrl, projectDir, generatedConfig)
  if (!litellmProcess) {
    logger.error("Failed to start LiteLLM proxy. Install with: pip install 'litellm[proxy]'")
    process.exit(1)
  }

  return litellmProcess
}

/**
 * Build the system prompt that includes project memory + passive learning instructions.
 * Claude Code will only write to memory when the user explicitly asks.
 */
export function buildMemorySystemPrompt(memory: string, projectDir: string): string {
  const memoryDir = path.join(projectDir, ".kody", "memory")
  const parts: string[] = []

  if (memory) {
    parts.push(memory)
  }

  parts.push([
    "# Kody Memory System",
    "",
    `This project uses Kody's memory at \`${memoryDir}/\`.`,
    "When the user asks you to remember something about this project, write it to the appropriate .md file there.",
    "Follow existing file naming (e.g., architecture.md, conventions.md, patterns.md).",
    "Check for duplicates before adding. Append new entries as bullet points under the relevant heading.",
    "Do NOT proactively write to memory — only when the user explicitly asks to remember or save something.",
  ].join("\n"))

  return parts.join("\n\n")
}

function launchClaudeCode(config: KodyConfig, projectDir: string): ReturnType<typeof spawn> {
  const usesProxy = anyStageNeedsProxy(config)
  const litellmUrl = getLitellmUrl()

  // Resolve which model to use for the interactive session
  const model = config.agent.default?.model
    ?? config.agent.modelMap.mid
    ?? config.agent.modelMap.cheap
    ?? Object.values(config.agent.modelMap)[0]

  const env: Record<string, string> = { ...process.env as Record<string, string> }

  if (usesProxy) {
    env.ANTHROPIC_BASE_URL = litellmUrl
    env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  const args: string[] = []
  if (model) {
    args.push("--model", model)
  }

  // Inject Kody's project memory + learning instructions
  const memory = readProjectMemory(projectDir)
  const memoryPrompt = buildMemorySystemPrompt(memory, projectDir)
  if (memoryPrompt) {
    args.push("--append-system-prompt", memoryPrompt)
    logger.info(`  Injected project memory (${memoryPrompt.length} chars)`)
  }

  logger.info(`Launching Claude Code${model ? ` (model: ${model})` : ""}`)
  if (usesProxy) {
    logger.info(`  ANTHROPIC_BASE_URL=${litellmUrl}`)
  }

  const child = spawn("claude", args, {
    stdio: "inherit",
    env,
    cwd: projectDir,
  })

  return child
}

export async function serveCommand(rawArgs: string[]): Promise<void> {
  const opts = parseServeArgs(rawArgs)

  // Resolve working directory
  const projectDir = opts.cwd ? path.resolve(opts.cwd) : process.cwd()
  if (opts.cwd) {
    if (!fs.existsSync(projectDir)) {
      logger.error(`--cwd path does not exist: ${projectDir}`)
      process.exit(1)
    }
    setConfigDir(projectDir)
  }

  // Load config
  const config = getProjectConfig()

  // Apply CLI overrides
  if (opts.provider || opts.model) {
    applyModelOverrides(config, opts.provider, opts.model)
    logger.info(`CLI override: provider=${config.agent.default?.provider} model=${config.agent.default?.model}`)
  }

  // Track processes for cleanup
  let litellmProcess: ReturnType<typeof spawn> | null = null
  let devServerHandle: DevServerHandle | null = null
  let claudeProcess: ReturnType<typeof spawn> | null = null

  const cleanup = () => {
    if (claudeProcess && !claudeProcess.killed) {
      claudeProcess.kill("SIGTERM")
    }
    if (devServerHandle) {
      logger.info("Stopping dev server...")
      devServerHandle.stop()
    }
    if (litellmProcess) {
      logger.info("Stopping LiteLLM proxy...")
      litellmProcess.kill()
    }
  }

  process.on("SIGINT", () => { cleanup(); process.exit(130) })
  process.on("SIGTERM", () => { cleanup(); process.exit(143) })

  // ─── 1. Start LiteLLM proxy ──────────────────────────────────────────────
  const usesProxy = anyStageNeedsProxy(config)
  if (usesProxy) {
    logger.info("Starting LiteLLM proxy...")
    litellmProcess = await ensureLitellmForServe(config, projectDir)

    // Health check
    const litellmUrl = getLitellmUrl()
    const apiKey = "health-check"
    const model = config.agent.default?.model
      ?? config.agent.modelMap.cheap
      ?? Object.values(config.agent.modelMap)[0]

    if (model) {
      logger.info(`Model health check (${model})...`)
      const result = await checkModelHealth(litellmUrl, apiKey, model)
      if (result.ok) {
        logger.info("  ✓ Model responded")
      } else {
        logger.warn(`  ✗ Model health check failed: ${result.error}`)
        logger.warn("  Continuing anyway — model may become available")
      }
    }
  } else {
    logger.info("No LiteLLM proxy needed (using Anthropic directly)")
  }

  // ─── 2. Start dev server ─────────────────────────────────────────────────
  if (config.devServer) {
    logger.info(`Starting dev server: ${config.devServer.command}`)
    devServerHandle = await startDevServer({
      command: config.devServer.command,
      url: config.devServer.url,
      readyPattern: config.devServer.readyPattern,
      readyTimeout: config.devServer.readyTimeout,
    })

    if (devServerHandle.ready) {
      logger.info(`  ✓ Dev server ready at ${devServerHandle.url}`)
    } else {
      logger.warn(`  ✗ Dev server may not be ready at ${devServerHandle.url}`)
    }
  }

  // ─── 3. Load project memory ────────────────────────────────────────────
  const memory = readProjectMemory(projectDir)
  const memoryFiles = (() => {
    const dir = path.join(projectDir, ".kody", "memory")
    if (!fs.existsSync(dir)) return 0
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length
  })()

  // ─── 4. Print connection info ────────────────────────────────────────────
  console.log("")
  console.log("╔══════════════════════════════════════════════╗")
  console.log("║           Kody Serve — Ready                 ║")
  console.log("╠══════════════════════════════════════════════╣")
  if (usesProxy) {
    const url = getLitellmUrl()
    console.log(`║  LiteLLM:    ${url.padEnd(32)}║`)
  }
  if (devServerHandle) {
    console.log(`║  Dev server: ${devServerHandle.url.padEnd(32)}║`)
  }
  const model = config.agent.default?.model
    ?? config.agent.modelMap.mid
    ?? config.agent.modelMap.cheap
  if (model) {
    console.log(`║  Model:      ${model.padEnd(32)}║`)
  }
  if (memory) {
    const memoryInfo = `${memoryFiles} files, ${memory.length} chars`
    console.log(`║  Memory:     ${memoryInfo.padEnd(32)}║`)
  } else {
    console.log(`║  Memory:     ${"(none)".padEnd(32)}║`)
  }
  console.log("╚══════════════════════════════════════════════╝")
  console.log("")

  // ─── 5. Launch Claude Code ───────────────────────────────────────────────
  if (opts.noClaude) {
    logger.info("--no-claude: Infrastructure running. Press Ctrl+C to stop.")
    // Keep alive
    await new Promise(() => {})
  } else {
    claudeProcess = launchClaudeCode(config, projectDir)

    claudeProcess.on("exit", (code) => {
      logger.info(`Claude Code exited (code: ${code})`)
      cleanup()
      process.exit(code ?? 0)
    })

    claudeProcess.on("error", (err) => {
      logger.error(`Failed to launch Claude Code: ${err.message}`)
      logger.info("Is 'claude' CLI installed? Run: npm install -g @anthropic-ai/claude-code")
      cleanup()
      process.exit(1)
    })
  }
}
