import * as fs from "fs"
import * as path from "path"

export interface TestRequirement {
  pattern: string
  requireSibling: string
}

export interface Kody2Config {
  quality: {
    typecheck: string
    lint: string
    testUnit: string
  }
  git: {
    defaultBranch: string
  }
  github: {
    owner: string
    repo: string
  }
  agent: {
    model: string
  }
  testRequirements?: TestRequirement[]
}

export interface ProviderModel {
  provider: string
  model: string
}

export const LITELLM_DEFAULT_PORT = 4000
export const LITELLM_DEFAULT_URL = `http://localhost:${LITELLM_DEFAULT_PORT}`

export function parseProviderModel(s: string): ProviderModel {
  const slash = s.indexOf("/")
  if (slash <= 0 || slash === s.length - 1) {
    throw new Error(
      `Invalid model spec '${s}' — expected 'provider/model' (e.g. 'minimax/MiniMax-M2.7-highspeed')`,
    )
  }
  return { provider: s.slice(0, slash), model: s.slice(slash + 1) }
}

export function providerApiKeyEnvVar(provider: string): string {
  if (provider === "anthropic" || provider === "claude") return "ANTHROPIC_API_KEY"
  return `${provider.toUpperCase()}_API_KEY`
}

export function needsLitellmProxy(model: ProviderModel): boolean {
  return model.provider !== "claude" && model.provider !== "anthropic"
}

export function loadConfig(projectDir: string = process.cwd()): Kody2Config {
  const configPath = path.join(projectDir, "kody.config.json")
  if (!fs.existsSync(configPath)) {
    throw new Error(`kody.config.json not found at ${configPath}`)
  }

  let raw: Record<string, any>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`kody.config.json is invalid JSON: ${msg}`)
  }

  const quality = raw.quality ?? {}
  const git = raw.git ?? {}
  const github = raw.github ?? {}
  const agent = raw.agent ?? {}

  if (!agent.model || typeof agent.model !== "string") {
    throw new Error(`kody.config.json: agent.model is required (e.g. "minimax/MiniMax-M2.7-highspeed")`)
  }
  if (!github.owner || !github.repo) {
    throw new Error(`kody.config.json: github.owner and github.repo are required`)
  }

  return {
    quality: {
      typecheck: typeof quality.typecheck === "string" ? quality.typecheck : "",
      lint: typeof quality.lint === "string" ? quality.lint : "",
      testUnit: typeof quality.testUnit === "string" ? quality.testUnit : "",
    },
    git: {
      defaultBranch: typeof git.defaultBranch === "string" ? git.defaultBranch : "main",
    },
    github: {
      owner: String(github.owner),
      repo: String(github.repo),
    },
    agent: {
      model: String(agent.model),
    },
    testRequirements: parseTestRequirements(raw.testRequirements),
  }
}

function parseTestRequirements(raw: unknown): TestRequirement[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TestRequirement[] = []
  for (const item of raw) {
    if (item && typeof item === "object" && typeof (item as { pattern?: unknown }).pattern === "string"
        && typeof (item as { requireSibling?: unknown }).requireSibling === "string") {
      out.push({
        pattern: (item as { pattern: string }).pattern,
        requireSibling: (item as { requireSibling: string }).requireSibling,
      })
    }
  }
  return out.length > 0 ? out : undefined
}

export function getAnthropicApiKeyOrDummy(): string {
  return process.env.ANTHROPIC_API_KEY || `sk-ant-api03-${"0".repeat(64)}`
}
