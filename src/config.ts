import * as fs from "fs"
import * as path from "path"
import { logger } from "./logger.js"
import { parseJsonSafe } from "./validators.js"

export interface RunnerConfig {
  type: "claude-code" | "sdk"
}

import type { ContextTier } from "./context-tiers.js"

export interface ContextTiersConfig {
  enabled: boolean
  tokenBudget?: number
  stageOverrides?: Partial<Record<string, Partial<Record<string, ContextTier>>>>
}

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface DevServerConfig {
  /** Command to start the dev server (e.g., "pnpm dev") */
  command: string
  /** URL where the dev server will be accessible (e.g., "http://localhost:3000") */
  url: string
  /** Regex pattern to match in stdout when server is ready (e.g., "Ready in") */
  readyPattern?: string
  /** Seconds to wait for the server to be ready before giving up. Default: 30 */
  readyTimeout?: number
}

export interface McpConfig {
  enabled: boolean
  servers: Record<string, McpServerConfig>
  /** Which stages can use MCP tools. Defaults to ["build", "verify", "review", "review-fix"] */
  stages?: string[]
  /** Dev server config — when set, browser tool guidance will include instructions to start and browse */
  devServer?: DevServerConfig
}

export interface StageConfig {
  provider: string  // "claude" = direct Anthropic, anything else = LiteLLM
  model: string     // e.g. "claude-sonnet-4-6", "MiniMax-M2.7-highspeed"
}

export interface KodyConfig {
  quality: {
    typecheck: string
    lint: string
    lintFix: string
    formatFix: string
    testUnit: string
  }
  git: {
    defaultBranch: string
  }
  github: {
    owner: string
    repo: string
    /** Post a pipeline summary comment on the issue after completion. Default: true in CI, false locally. */
    postSummary?: boolean
  }
  agent: {
    modelMap: Record<string, string>
    /** LLM provider name (e.g. "minimax", "openai", "google"). When set, engine auto-starts LiteLLM proxy. */
    provider?: string
    /** Per-stage provider + model overrides. Takes precedence over modelMap. */
    default?: StageConfig
    /** Per-stage provider + model. Overrides default and modelMap. */
    stages?: Record<string, StageConfig>
    /** When true (default), escalate to a stronger model tier on timeout retries */
    escalateOnTimeout?: boolean
    // Multi-runner (advanced)
    runners?: Record<string, RunnerConfig>
    defaultRunner?: string
    stageRunners?: Record<string, string>
  }
  timeouts?: Record<string, number>
  contextTiers?: ContextTiersConfig
  mcp?: McpConfig
  /** Dev server config — decoupled from MCP so any provider can use browser verification */
  devServer?: DevServerConfig
  watch?: {
    enabled?: boolean
    digestIssue?: number
    /** Model for watch agents. Falls back to agent.modelMap.cheap */
    model?: string
  }
  decompose?: {
    /** Enable decompose command. Default: true */
    enabled?: boolean
    /** Max concurrent sub-task builds. Default: 3 */
    maxParallelSubTasks?: number
    /** Minimum complexity score (1-10) to decompose. Default: 6 */
    minComplexityScore?: number
  }
  release?: {
    /** Files containing version strings to update. Default: ["package.json"] */
    versionFiles?: string[]
    /** Shell command to publish after tagging. Empty = skip. */
    publishCommand?: string
    /** Shell command for post-release notifications. $VERSION is interpolated. Empty = skip. */
    notifyCommand?: string
    /** Target branch for release PRs. Defaults to git.defaultBranch. */
    releaseBranch?: string
    /** Labels to add to the release PR. Default: ["release"] */
    labels?: string[]
    /** Create GitHub Releases as drafts. Default: false */
    draftRelease?: boolean
  }
}

const DEFAULT_CONFIG: KodyConfig = {
  quality: {
    typecheck: "pnpm -s tsc --noEmit",
    lint: "pnpm -s lint",
    lintFix: "pnpm lint:fix",
    formatFix: "pnpm format:fix",
    testUnit: "pnpm -s test",
  },
  git: {
    defaultBranch: "dev",
  },
  github: {
    owner: "",
    repo: "",
  },
  agent: {
    modelMap: {},
  },
  contextTiers: {
    enabled: true,
    tokenBudget: 8000,
  },
}

// LiteLLM constants
export const LITELLM_DEFAULT_PORT = 4000
export const LITELLM_DEFAULT_URL = `http://localhost:${LITELLM_DEFAULT_PORT}`

/**
 * Claude Code CLI requires ANTHROPIC_API_KEY to start, even when routing
 * through LiteLLM. Returns the real key if set, otherwise a dummy key
 * that satisfies CLI validation while LiteLLM handles actual auth.
 */
export function getAnthropicApiKeyOrDummy(): string {
  return process.env.ANTHROPIC_API_KEY || `sk-ant-api03-${"0".repeat(64)}`
}

/**
 * Resolve provider + model for a specific stage.
 * Priority: agent.stages[stageName] > agent.default > legacy agent.provider + modelMap
 */
export function resolveStageConfig(config: KodyConfig, stageName: string, modelTier: string): StageConfig {
  // Per-stage override
  const stageOverride = config.agent.stages?.[stageName]
  if (stageOverride) return stageOverride

  // Default override
  if (config.agent.default) return config.agent.default

  // Legacy fallback: derive from provider + modelMap (all names from config, nothing hardcoded)
  const model = config.agent.modelMap[modelTier]
  if (!model) {
    throw new Error(`No model configured for stage '${stageName}' (tier: ${modelTier}). Set agent.stages.${stageName} or agent.default in kody.config.json`)
  }
  return {
    provider: config.agent.provider ?? "claude",
    model,
  }
}

/** Apply CLI --provider / --model overrides to all stages.
 *  Mutates the cached config so every downstream resolveStageConfig / resolveModel picks it up. */
export function applyModelOverrides(config: KodyConfig, provider?: string, model?: string): void {
  if (!provider && !model) return

  const fallbackProvider = config.agent.default?.provider ?? config.agent.provider ?? "claude"
  const fallbackModel = config.agent.default?.model
    ?? config.agent.modelMap.mid ?? config.agent.modelMap.cheap
    ?? Object.values(config.agent.modelMap)[0] ?? ""

  const overrideProvider = provider ?? fallbackProvider
  const overrideModel = model ?? fallbackModel

  // Set default (covers resolveStageConfig path)
  config.agent.default = { provider: overrideProvider, model: overrideModel }

  // Clear per-stage overrides so CLI flag applies uniformly
  config.agent.stages = undefined

  // Override all modelMap tiers (covers resolveModel path used by escalation + verify)
  if (model) {
    for (const tier of Object.keys(config.agent.modelMap)) {
      config.agent.modelMap[tier] = model
    }
  }

  // Set legacy provider field for proxy detection
  if (provider) {
    config.agent.provider = overrideProvider
  }
}

/** Check if a provider needs LiteLLM proxy */
export function needsLitellmProxy(config: KodyConfig): boolean {
  return !!(config.agent.provider && config.agent.provider !== "anthropic")
}

/** Check if a specific stage needs LiteLLM proxy */
export function stageNeedsProxy(stageConfig: StageConfig): boolean {
  return stageConfig.provider !== "claude" && stageConfig.provider !== "anthropic"
}

/** Check if any stage uses a non-claude provider (i.e. LiteLLM is needed) */
export function anyStageNeedsProxy(config: KodyConfig): boolean {
  // Check per-stage configs
  if (config.agent.stages) {
    for (const sc of Object.values(config.agent.stages)) {
      if (stageNeedsProxy(sc)) return true
    }
  }
  // Check default
  if (config.agent.default && stageNeedsProxy(config.agent.default)) return true
  // Legacy fallback
  return needsLitellmProxy(config)
}

/** Get the LiteLLM proxy URL */
export function getLitellmUrl(): string {
  return LITELLM_DEFAULT_URL
}

/** Get the env var name for a provider's API key.
 *  Derives from provider name: openai→OPENAI_API_KEY, gemini→GEMINI_API_KEY, etc.
 *  Returns the provider-specific env var name (e.g. MINIMAX_API_KEY for "minimax"). */
export function providerApiKeyEnvVar(provider: string): string {
  if (provider === "anthropic" || provider === "claude") return "ANTHROPIC_API_KEY"
  return `${provider.toUpperCase()}_API_KEY`
}

// Pipeline constants
export const SIGKILL_GRACE_MS = 5000
export const MAX_PR_TITLE_LENGTH = 72
export const STDERR_TAIL_CHARS = 2000
export const API_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_FIX_ATTEMPTS = 2
export const AGENT_RETRY_DELAY_MS = 2000
export const VERIFY_COMMAND_TIMEOUT_MS = 5 * 60 * 1000
export const FIX_COMMAND_TIMEOUT_MS = 2 * 60 * 1000

let _config: KodyConfig | null = null
let _configDir: string | null = null

export function setConfigDir(dir: string): void {
  _configDir = dir
  _config = null
}

export function getProjectConfig(): KodyConfig {
  if (_config) return _config

  const configPath = path.join(_configDir ?? process.cwd(), "kody.config.json")
  if (fs.existsSync(configPath)) {
    try {
      const result = parseJsonSafe<Record<string, unknown>>(fs.readFileSync(configPath, "utf-8"))
      if (!result.ok) {
        logger.warn(`kody.config.json: ${result.error} — using defaults`)
        _config = { ...DEFAULT_CONFIG }
        return _config
      }
      const raw = result.data as Record<string, any>
      _config = {
        quality: { ...DEFAULT_CONFIG.quality, ...raw.quality },
        git: { ...DEFAULT_CONFIG.git, ...raw.git },
        github: { ...DEFAULT_CONFIG.github, ...raw.github },
        agent: {
          ...DEFAULT_CONFIG.agent,
          ...raw.agent,
          modelMap: { ...DEFAULT_CONFIG.agent.modelMap, ...raw.agent?.modelMap },
        },
        timeouts: raw.timeouts ?? undefined,
        contextTiers: raw.contextTiers
          ? { ...DEFAULT_CONFIG.contextTiers, ...raw.contextTiers }
          : DEFAULT_CONFIG.contextTiers,
        mcp: raw.mcp
          ? {
              servers: {},
              stages: ["build", "verify", "review", "review-fix"],
              ...raw.mcp,
              // Only auto-enable when explicit MCP servers are configured (devServer alone is not MCP)
              enabled: raw.mcp.enabled ?? (!!raw.mcp.servers && Object.keys(raw.mcp.servers).length > 0),
            }
          : undefined,
        // Top-level devServer takes precedence; fall back to mcp.devServer for backward compat
        devServer: raw.devServer ?? raw.mcp?.devServer ?? undefined,
        watch: raw.watch
          ? {
              enabled: raw.watch.enabled ?? false,
              digestIssue: raw.watch.digestIssue,
              model: raw.watch.model,
            }
          : undefined,
        decompose: raw.decompose
          ? {
              enabled: raw.decompose.enabled ?? true,
              maxParallelSubTasks: raw.decompose.maxParallelSubTasks ?? 3,
              minComplexityScore: raw.decompose.minComplexityScore ?? 6,
            }
          : undefined,
        release: raw.release
          ? {
              versionFiles: raw.release.versionFiles ?? ["package.json"],
              publishCommand: raw.release.publishCommand ?? "",
              notifyCommand: raw.release.notifyCommand ?? "",
              releaseBranch: raw.release.releaseBranch ?? undefined,
              labels: raw.release.labels ?? ["kody:release"],
              draftRelease: raw.release.draftRelease ?? false,
            }
          : undefined,
      }
    } catch {
      logger.warn("kody.config.json is invalid JSON — using defaults")
      _config = { ...DEFAULT_CONFIG }
    }
  } else {
    _config = { ...DEFAULT_CONFIG }
  }

  return _config
}

export function resetProjectConfig(): void {
  _config = null
  _configDir = null
}
