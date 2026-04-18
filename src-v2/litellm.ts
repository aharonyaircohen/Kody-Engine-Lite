import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync, spawn, type ChildProcess } from "child_process"
import {
  type ProviderModel,
  providerApiKeyEnvVar,
  needsLitellmProxy,
  LITELLM_DEFAULT_URL,
} from "./config.js"

export async function checkLitellmHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

export function generateLitellmConfigYaml(model: ProviderModel): string {
  const apiKeyVar = providerApiKeyEnvVar(model.provider)
  return [
    "model_list:",
    `  - model_name: ${model.model}`,
    `    litellm_params:`,
    `      model: ${model.provider}/${model.model}`,
    `      api_key: os.environ/${apiKeyVar}`,
    "",
    "litellm_settings:",
    "  drop_params: true",
    "",
  ].join("\n")
}

export interface LitellmHandle {
  url: string
  kill: () => void
}

export async function startLitellmIfNeeded(
  model: ProviderModel,
  projectDir: string,
  url: string = LITELLM_DEFAULT_URL,
): Promise<LitellmHandle | null> {
  if (!needsLitellmProxy(model)) return null

  if (await checkLitellmHealth(url)) {
    return { url, kill: () => {} }
  }

  let cmd = "litellm"
  let args: string[]
  try {
    execFileSync("which", ["litellm"], { timeout: 3000, stdio: "pipe" })
  } catch {
    try {
      execFileSync("python3", ["-c", "import litellm"], { timeout: 10000, stdio: "pipe" })
      cmd = "python3"
    } catch {
      throw new Error("litellm not installed — run: pip install 'litellm[proxy]'")
    }
  }

  const configPath = path.join(os.tmpdir(), `kody-lean-litellm-${Date.now()}.yaml`)
  fs.writeFileSync(configPath, generateLitellmConfigYaml(model))

  const portMatch = url.match(/:(\d+)/)
  const port = portMatch ? portMatch[1] : "4000"
  args = cmd === "litellm"
    ? ["--config", configPath, "--port", port]
    : ["-m", "litellm", "--config", configPath, "--port", port]

  const dotenvVars = readDotenvApiKeys(projectDir)
  const logPath = path.join(os.tmpdir(), `kody-lean-litellm-${Date.now()}.log`)
  const outFd = fs.openSync(logPath, "w")

  const child = spawn(cmd, args, {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    env: stripBlockingEnv({ ...process.env, ...dotenvVars }),
  })
  fs.closeSync(outFd)

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await checkLitellmHealth(url)) {
      return { url, kill: () => { try { child.kill() } catch { /* best effort */ } } }
    }
  }

  let logTail = ""
  try { logTail = fs.readFileSync(logPath, "utf-8").slice(-2000) } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  throw new Error(`LiteLLM proxy failed to start within 60s. Log tail:\n${logTail}`)
}

function readDotenvApiKeys(projectDir: string): Record<string, string> {
  const dotenvPath = path.join(projectDir, ".env")
  if (!fs.existsSync(dotenvPath)) return {}
  const result: Record<string, string> = {}
  for (const rawLine of fs.readFileSync(dotenvPath, "utf-8").split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(/^([A-Z_][A-Z0-9_]*_API_KEY)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    const commentIdx = value.indexOf(" #")
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim()
    if (value) result[match[1]] = value
  }
  return result
}

function stripBlockingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  delete out.DATABASE_URL
  delete out.AI_BASE_URL
  return out
}
