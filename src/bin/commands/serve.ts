/**
 * `kody serve` — Start Kody infrastructure locally and launch Claude Code.
 *
 * Sets up the same environment that GH Actions gets:
 *   1. Reads kody.config.json
 *   2. Starts LiteLLM proxy (if non-Anthropic provider configured)
 *   3. Starts dev server (if configured)
 *   4. Writes .claude/kody-context.md (memory + learning instructions)
 *   5. Launches Claude Code CLI or VS Code with env vars
 *
 * Usage:
 *   kody-engine serve                           # launches Claude Code CLI
 *   kody-engine serve --vscode                  # launches VS Code with env vars
 *   kody-engine serve --no-claude               # infra only
 *   kody-engine serve --provider minimax --model MiniMax-M1
 *   kody-engine serve --cwd /path/to/project
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
  vscode?: boolean
}

function parseServeArgs(args: string[]): ServeOptions {
  return {
    cwd: getArg(args, "--cwd"),
    provider: getArg(args, "--provider"),
    model: getArg(args, "--model"),
    noClaude: args.includes("--no-claude"),
    vscode: args.includes("--vscode"),
  }
}

// Claude model names that Claude Code CLI / VS Code extension may send
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
 * This ensures that when Claude Code (CLI or VS Code extension) requests
 * any Claude model, the proxy routes it to the configured provider model.
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
    // No base config — generate from scratch
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

  // Append aliases before any litellm_settings block
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

  // Generate config from per-stage configs or legacy provider
  let generatedConfig: string | undefined
  if (config.agent.stages || config.agent.default) {
    generatedConfig = generateLitellmConfigFromStages(config.agent.default, config.agent.stages)
  } else if (config.agent.provider && config.agent.provider !== "anthropic") {
    generatedConfig = generateLitellmConfig(config.agent.provider, config.agent.modelMap)
  }

  // Add aliases for Claude model names so CLI/VS Code extension works
  const targetModel = config.agent.default?.model
    ?? Object.values(config.agent.modelMap)[0]
  const provider = config.agent.default?.provider
    ?? config.agent.provider ?? "minimax"

  if (targetModel && provider !== "claude" && provider !== "anthropic") {
    generatedConfig = augmentConfigWithAliases(generatedConfig, provider, targetModel)
  }

  if (proxyRunning) {
    logger.info(`LiteLLM proxy already running at ${litellmUrl} (restart to pick up aliases)`)
    // TODO: check if proxy has aliases, restart if not
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
 * Build the content for .claude/kody-context.md.
 * Includes project memory + passive learning instructions.
 * This file is read by both Claude Code CLI and VS Code extension.
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

/**
 * Write .claude/kody-context.md so both CLI and VS Code extension pick it up.
 * Returns the file path written.
 */
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

/**
 * Build env for proxy mode. Sets ANTHROPIC_BASE_URL for routing and
 * ANTHROPIC_API_KEY (real or dummy) so Claude Code skips OAuth login.
 * All API calls go to the proxy — the key is only for local auth check.
 */
function buildProxyEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: getLitellmUrl(),
    ANTHROPIC_API_KEY: getAnthropicApiKeyOrDummy(),
  }
}

function launchClaudeCode(config: KodyConfig, projectDir: string): ReturnType<typeof spawn> {
  const usesProxy = anyStageNeedsProxy(config)

  // Resolve which model to use for the interactive session
  const model = config.agent.default?.model
    ?? config.agent.modelMap.mid
    ?? config.agent.modelMap.cheap
    ?? Object.values(config.agent.modelMap)[0]

  const args: string[] = []
  if (model) {
    args.push("--model", model)
  }

  logger.info(`Launching Claude Code${model ? ` (model: ${model})` : ""}`)
  if (usesProxy) {
    logger.info(`  ANTHROPIC_BASE_URL=${getLitellmUrl()}`)
  }

  // Only pass custom env when proxy needs it — otherwise inherit naturally
  // to preserve OAuth tokens, PATH, and other auth state
  const spawnOpts: Parameters<typeof spawn>[2] = {
    stdio: "inherit",
    cwd: projectDir,
  }
  if (usesProxy) {
    spawnOpts.env = buildProxyEnv()
  }

  const child = spawn("claude", args, spawnOpts)

  return child
}

function launchVSCode(config: KodyConfig, projectDir: string): ReturnType<typeof spawn> {
  const usesProxy = anyStageNeedsProxy(config)

  logger.info("Launching VS Code...")
  if (usesProxy) {
    logger.info(`  ANTHROPIC_BASE_URL=${getLitellmUrl()}`)
  }

  const spawnOpts: Parameters<typeof spawn>[2] = {
    stdio: "inherit",
  }
  if (usesProxy) {
    spawnOpts.env = buildProxyEnv()
  }

  const child = spawn("code", [projectDir], spawnOpts)

  return child
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
    const healthModel = config.agent.default?.model
      ?? config.agent.modelMap.cheap
      ?? Object.values(config.agent.modelMap)[0]

    if (healthModel) {
      logger.info(`Model health check (${healthModel})...`)
      const result = await checkModelHealth(litellmUrl, apiKey, healthModel)
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

  // ─── 3. Write .claude/kody-context.md ────────────────────────────────────
  const memory = readProjectMemory(projectDir)
  const contextContent = buildKodyContextContent(memory, projectDir)
  const contextPath = writeKodyContext(projectDir, contextContent)

  const memoryFiles = (() => {
    const dir = path.join(projectDir, ".kody", "memory")
    if (!fs.existsSync(dir)) return 0
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length
  })()

  // ─── 4. Print connection info ────────────────────────────────────────────
  const model = config.agent.default?.model
    ?? config.agent.modelMap.mid
    ?? config.agent.modelMap.cheap

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
  if (model) {
    console.log(`║  Model:      ${model.padEnd(32)}║`)
  }
  if (memory) {
    const memoryInfo = `${memoryFiles} files, ${memory.length} chars`
    console.log(`║  Memory:     ${memoryInfo.padEnd(32)}║`)
  } else {
    console.log(`║  Memory:     ${"(none)".padEnd(32)}║`)
  }
  console.log(`║  Context:    ${contextPath.padEnd(32)}║`)
  console.log("╚══════════════════════════════════════════════╝")
  console.log("")

  // ─── 5. Launch Claude Code or VS Code ────────────────────────────────────
  if (opts.noClaude) {
    logger.info("--no-claude: Infrastructure running. Press Ctrl+C to stop.")
    // Keep alive
    await new Promise(() => {})
  } else if (opts.vscode) {
    const child = launchVSCode(config, projectDir)

    child.on("exit", (code) => {
      logger.info(`VS Code launched (code: ${code})`)
      // VS Code spawns and detaches — don't cleanup infra, keep it running
      if (usesProxy || devServerHandle) {
        logger.info("Infrastructure still running. Press Ctrl+C to stop.")
      } else {
        cleanup()
        process.exit(code ?? 0)
      }
    })

    child.on("error", (err) => {
      logger.error(`Failed to launch VS Code: ${err.message}`)
      logger.info("Is 'code' CLI installed? Run: Shell Command: Install 'code' command in PATH")
      cleanup()
      process.exit(1)
    })

    // VS Code detaches quickly — keep alive for infra
    if (usesProxy || devServerHandle) {
      await new Promise(() => {})
    }
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
