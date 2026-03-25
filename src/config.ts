import * as fs from "fs"
import * as path from "path"

export interface KodyConfig {
  quality: {
    typecheck: string
    lint: string
    lintFix: string
    format: string
    formatFix: string
    testUnit: string
  }
  git: {
    defaultBranch: string
  }
  paths: {
    taskDir: string
  }
  agent: {
    runner: string
    modelMap: { cheap: string; mid: string; strong: string }
  }
}

const DEFAULT_CONFIG: KodyConfig = {
  quality: {
    typecheck: "pnpm -s tsc --noEmit",
    lint: "pnpm -s lint",
    lintFix: "pnpm lint:fix",
    format: "pnpm -s format:check",
    formatFix: "pnpm format:fix",
    testUnit: "pnpm -s test",
  },
  git: {
    defaultBranch: "dev",
  },
  paths: {
    taskDir: ".tasks",
  },
  agent: {
    runner: "claude-code",
    modelMap: { cheap: "haiku", mid: "sonnet", strong: "opus" },
  },
}

// Pipeline constants
export const SIGKILL_GRACE_MS = 5000
export const MAX_PR_TITLE_LENGTH = 72
export const STDERR_TAIL_CHARS = 500
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
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      _config = {
        quality: { ...DEFAULT_CONFIG.quality, ...raw.quality },
        git: { ...DEFAULT_CONFIG.git, ...raw.git },
        paths: { ...DEFAULT_CONFIG.paths, ...raw.paths },
        agent: { ...DEFAULT_CONFIG.agent, ...raw.agent },
      }
    } catch {
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
