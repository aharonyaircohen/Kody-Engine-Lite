/**
 * `kody serve` — Start Kody infrastructure for local development.
 *
 * Subcommands:
 *   kody-engine serve          — Start LiteLLM proxy + dev server + context file
 *   kody-engine serve claude   — Above + launch Claude Code CLI
 *   kody-engine serve vscode   — Above + launch VS Code with env vars
 *
 * Options:
 *   --cwd /path                — Target a different project
 *   --provider minimax         — Override LLM provider
 *   --model MiniMax-M1         — Override model
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

// ─── Types ─────────────────────────────────────────────────────────────────

type ServeMode = "infra" | "claude" | "vscode"

interface ServeOptions {
  mode: ServeMode
  cwd?: string
  provider?: string
  model?: string
}

// ─── Arg parsing ───────────────────────────────────────────────────────────

function parseServeArgs(args: string[]): ServeOptions {
  const subcommand = args[0]
  let mode: ServeMode = "infra"
  if (subcommand === "claude") mode = "claude"
  else if (subcommand === "vscode") mode = "vscode"

  return {
    mode,
    cwd: getArg(args, "--cwd"),
    provider: getArg(args, "--provider"),
    model: getArg(args, "--model"),
  }
}

// ─── LiteLLM proxy ────────────────────────────────────────────────────────

/** Claude model names that Claude Code CLI / VS Code extension may send */
const CLAUDE_MODEL_ALIASES = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
  "claude-sonnet-4-5-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
]

/**
 * Augment LiteLLM config with aliases for common Claude model names.
 * Ensures that when Claude Code sends any Claude model name,
 * the proxy routes it to the configured provider model.
 */
export function augmentConfigWithAliases(
  baseConfig: string | undefined,
  provider: string,
  targetModel: string,
): string {
  const apiKeyVar = `os.environ/${provider.toUpperCase()}_API_KEY`
  const providerModel = `${provider}/${targetModel}`

  const aliases: string[] = []
  for (const alias of CLAUDE_MODEL_ALIASES) {
    if (alias === targetModel) continue
    aliases.push(`  - model_name: ${alias}`)
    aliases.push(`    litellm_params:`)
    aliases.push(`      model: ${providerModel}`)
    aliases.push(`      api_key: ${apiKeyVar}`)
  }

  if (!baseConfig) {
    const entries = [
      "model_list:",
      `  - model_name: ${targetModel}`,
      `    litellm_params:`,
      `      model: ${providerModel}`,
      `      api_key: ${apiKeyVar}`,
      ...aliases,
      "",
      "litellm_settings:",
      "  drop_params: true",
    ]
    return entries.join("\n") + "\n"
  }

  const settingsIdx = baseConfig.indexOf("\nlitellm_settings:")
  if (settingsIdx !== -1) {
    return baseConfig.slice(0, settingsIdx) + "\n" + aliases.join("\n") + baseConfig.slice(settingsIdx)
  }

  return baseConfig + "\n" + aliases.join("\n") + "\n"
}

async function ensureLitellmForServe(
  config: KodyConfig,
  projectDir: string,
): Promise<ReturnType<typeof spawn> | null> {
  if (!anyStageNeedsProxy(config)) return null

  const litellmUrl = getLitellmUrl()
  const proxyRunning = await checkLitellmHealth(litellmUrl)

  let generatedConfig: string | undefined
  if (config.agent.stages || config.agent.default) {
    generatedConfig = generateLitellmConfigFromStages(config.agent.default, config.agent.stages)
  } else if (config.agent.provider && config.agent.provider !== "anthropic") {
    generatedConfig = generateLitellmConfig(config.agent.provider, config.agent.modelMap)
  }

  // Add Claude model aliases so CLI/VS Code extension works
  const targetModel = config.agent.default?.model
    ?? Object.values(config.agent.modelMap)[0]
  const provider = config.agent.default?.provider
    ?? config.agent.provider ?? "minimax"

  if (targetModel && provider !== "claude" && provider !== "anthropic") {
    generatedConfig = augmentConfigWithAliases(generatedConfig, provider, targetModel)
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

// ─── Context file (.claude/kody-context.md) ────────────────────────────────

const KODY_CONTEXT_FILENAME = "kody-context.md"

/**
 * Build content for .claude/kody-context.md.
 * Read by both Claude Code CLI and VS Code extension.
 */
export function buildKodyContextContent(memory: string, projectDir: string): string {
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

export function writeKodyContext(projectDir: string, content: string): string {
  const claudeDir = path.join(projectDir, ".claude")
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true })
  }
  const filePath = path.join(claudeDir, KODY_CONTEXT_FILENAME)
  fs.writeFileSync(filePath, content, "utf-8")
  return filePath
}

// ─── Launch helpers ────────────────────────────────────────────────────────

function buildProxyEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: getLitellmUrl(),
    ANTHROPIC_API_KEY: getAnthropicApiKeyOrDummy(),
  }
}

function launchClaudeCode(config: KodyConfig, projectDir: string): ReturnType<typeof spawn> {
  const usesProxy = anyStageNeedsProxy(config)
  const model = config.agent.default?.model
    ?? config.agent.modelMap.mid
    ?? config.agent.modelMap.cheap
    ?? Object.values(config.agent.modelMap)[0]

  const args: string[] = []
  if (model) args.push("--model", model)

  logger.info(`Launching Claude Code${model ? ` (model: ${model})` : ""}`)
  if (usesProxy) logger.info(`  ANTHROPIC_BASE_URL=${getLitellmUrl()}`)

  const spawnOpts: Parameters<typeof spawn>[2] = { stdio: "inherit", cwd: projectDir }
  if (usesProxy) spawnOpts.env = buildProxyEnv()

  return spawn("claude", args, spawnOpts)
}

function launchVSCode(config: KodyConfig, projectDir: string): ReturnType<typeof spawn> {
  const usesProxy = anyStageNeedsProxy(config)

  logger.info("Launching VS Code...")
  if (usesProxy) logger.info(`  ANTHROPIC_BASE_URL=${getLitellmUrl()}`)

  const spawnOpts: Parameters<typeof spawn>[2] = { stdio: "inherit" }
  if (usesProxy) spawnOpts.env = buildProxyEnv()

  return spawn("code", [projectDir], spawnOpts)
}

// ─── Main ──────────────────────────────────────────────────────────────────

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

  // Load config + apply overrides
  const config = getProjectConfig()
  if (opts.provider || opts.model) {
    applyModelOverrides(config, opts.provider, opts.model)
    logger.info(`CLI override: provider=${config.agent.default?.provider} model=${config.agent.default?.model}`)
  }

  // Track processes for cleanup
  let litellmProcess: ReturnType<typeof spawn> | null = null
  let devServerHandle: DevServerHandle | null = null
  let launchedProcess: ReturnType<typeof spawn> | null = null

  const cleanup = () => {
    if (launchedProcess && !launchedProcess.killed) launchedProcess.kill("SIGTERM")
    if (devServerHandle) { logger.info("Stopping dev server..."); devServerHandle.stop() }
    if (litellmProcess) { logger.info("Stopping LiteLLM proxy..."); litellmProcess.kill() }
  }

  process.on("SIGINT", () => { cleanup(); process.exit(130) })
  process.on("SIGTERM", () => { cleanup(); process.exit(143) })

  // ─── 1. Start LiteLLM proxy ──────────────────────────────────────────────
  const usesProxy = anyStageNeedsProxy(config)
  if (usesProxy) {
    logger.info("Starting LiteLLM proxy...")
    litellmProcess = await ensureLitellmForServe(config, projectDir)

    const litellmUrl = getLitellmUrl()
    const healthModel = config.agent.default?.model
      ?? config.agent.modelMap.cheap
      ?? Object.values(config.agent.modelMap)[0]

    if (healthModel) {
      logger.info(`Model health check (${healthModel})...`)
      const result = await checkModelHealth(litellmUrl, "health-check", healthModel)
      if (result.ok) logger.info("  ✓ Model responded")
      else logger.warn(`  ✗ Health check failed: ${result.error} (continuing)`)
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
    if (devServerHandle.ready) logger.info(`  ✓ Dev server ready at ${devServerHandle.url}`)
    else logger.warn(`  ✗ Dev server may not be ready at ${devServerHandle.url}`)
  }

  // ─── 3. Write .claude/kody-context.md ────────────────────────────────────
  const memory = readProjectMemory(projectDir)
  const contextContent = buildKodyContextContent(memory, projectDir)
  const contextPath = writeKodyContext(projectDir, contextContent)
  const memoryFileCount = (() => {
    const dir = path.join(projectDir, ".kody", "memory")
    if (!fs.existsSync(dir)) return 0
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length
  })()

  // ─── 4. Print status ────────────────────────────────────────────────────
  const model = config.agent.default?.model
    ?? config.agent.modelMap.mid
    ?? config.agent.modelMap.cheap

  console.log("")
  console.log("╔══════════════════════════════════════════════╗")
  console.log("║           Kody Serve — Ready                 ║")
  console.log("╠══════════════════════════════════════════════╣")
  if (usesProxy) console.log(`║  LiteLLM:    ${getLitellmUrl().padEnd(32)}║`)
  if (devServerHandle) console.log(`║  Dev server: ${devServerHandle.url.padEnd(32)}║`)
  if (model) console.log(`║  Model:      ${model.padEnd(32)}║`)
  const memInfo = memory ? `${memoryFileCount} files, ${memory.length} chars` : "(none)"
  console.log(`║  Memory:     ${memInfo.padEnd(32)}║`)
  console.log(`║  Context:    ${KODY_CONTEXT_FILENAME.padEnd(32)}║`)
  console.log("╚══════════════════════════════════════════════╝")
  console.log("")

  // ─── 5. Launch subcommand (or stay alive for infra-only) ─────────────────
  if (opts.mode === "infra") {
    logger.info("Infrastructure running. Press Ctrl+C to stop.")
    logger.info("  Use 'kody-engine serve claude' or 'kody-engine serve vscode' to also launch an editor.")
    await new Promise(() => {})
  }

  if (opts.mode === "claude") {
    launchedProcess = launchClaudeCode(config, projectDir)

    launchedProcess.on("exit", (code) => {
      logger.info(`Claude Code exited (code: ${code})`)
      cleanup()
      process.exit(code ?? 0)
    })

    launchedProcess.on("error", (err) => {
      logger.error(`Failed to launch Claude Code: ${err.message}`)
      cleanup()
      process.exit(1)
    })
  }

  if (opts.mode === "vscode") {
    launchedProcess = launchVSCode(config, projectDir)

    launchedProcess.on("exit", () => {
      // VS Code spawns and detaches — keep infra running
      logger.info("VS Code launched. Infrastructure still running. Press Ctrl+C to stop.")
    })

    launchedProcess.on("error", (err) => {
      logger.error(`Failed to launch VS Code: ${err.message}`)
      cleanup()
      process.exit(1)
    })

    // Keep alive for infra
    await new Promise(() => {})
  }
}
