import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"

import { logger } from "../logger.js"
import { TIER_TO_ANTHROPIC_IDS, providerApiKeyEnvVar } from "../config.js"

export async function checkLitellmHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Validate that the API key can reach the model by sending a minimal chat request.
 * Works for both direct Anthropic API and LiteLLM proxy.
 */
export async function checkModelHealth(
  baseUrl: string,
  apiKey: string,
  model: string = "claude-haiku-4-5",
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4,
        messages: [{ role: "user", content: "Reply with: ok" }],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
    }

    const body = await res.json()
    // Accept both Anthropic format (content[0].text) and OpenAI format (choices[0].message.content)
    const hasAnthropicContent = !!body.content?.[0]?.text
    const hasOpenAIContent = !!body.choices?.[0]?.message?.content
    if (!hasAnthropicContent && !hasOpenAIContent) {
      return { ok: false, error: `Unexpected response format: ${JSON.stringify(body).slice(0, 200)}` }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Generate LiteLLM config YAML from provider + modelMap.
 * Maps all Anthropic model IDs (that Claude Code might send) to the provider's model.
 */
export function generateLitellmConfig(
  provider: string,
  modelMap: { cheap: string; mid: string; strong: string },
): string {
  const apiKeyVar = providerApiKeyEnvVar(provider)
  const entries: string[] = ["model_list:"]

  // For each tier (cheap/mid/strong), map all known Anthropic model IDs to the provider model
  for (const [tier, providerModel] of Object.entries(modelMap)) {
    const anthropicIds = TIER_TO_ANTHROPIC_IDS[tier]
    if (!anthropicIds) continue
    for (const modelName of anthropicIds) {
      entries.push(`  - model_name: ${modelName}`)
      entries.push(`    litellm_params:`)
      entries.push(`      model: ${provider}/${providerModel}`)
      entries.push(`      api_key: os.environ/${apiKeyVar}`)
    }
  }

  return entries.join("\n") + "\n"
}

export async function tryStartLitellm(
  url: string,
  projectDir: string,
  generatedConfig?: string,
): Promise<ReturnType<typeof import("child_process").spawn> | null> {
  if (!generatedConfig) {
    logger.warn("No provider configured in kody.config.json — cannot start LiteLLM proxy")
    return null
  }
  const configPath = path.join(os.tmpdir(), "kody-litellm-config.yaml")
  fs.writeFileSync(configPath, generatedConfig)

  // Extract port from URL
  const portMatch = url.match(/:(\d+)/)
  const port = portMatch ? portMatch[1] : "4000"

  // Check if litellm is installed (use `which` — litellm imports are too slow for --version)
  let litellmFound = false
  try {
    execFileSync("which", ["litellm"], { timeout: 3000, stdio: "pipe" })
    litellmFound = true
  } catch {
    try {
      execFileSync("python3", ["-c", "import litellm"], { timeout: 10000, stdio: "pipe" })
      litellmFound = true
    } catch {
      // not found
    }
  }
  if (!litellmFound) {
    logger.warn("litellm not installed (pip install 'litellm[proxy]')")
    return null
  }

  logger.info(`Starting LiteLLM proxy on port ${port}...`)

  // Determine command
  let cmd: string
  let args: string[]
  try {
    execFileSync("which", ["litellm"], { timeout: 3000, stdio: "pipe" })
    cmd = "litellm"
    args = ["--config", configPath, "--port", port]
  } catch {
    cmd = "python3"
    args = ["-m", "litellm", "--config", configPath, "--port", port]
  }

  // Load API key env vars from project .env (only *_API_KEY patterns)
  const dotenvPath = path.join(projectDir, ".env")
  const dotenvVars: Record<string, string> = {}
  if (fs.existsSync(dotenvPath)) {
    for (const line of fs.readFileSync(dotenvPath, "utf-8").split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*_API_KEY)=(.*)$/)
      if (match) dotenvVars[match[1]] = match[2]
    }
    if (Object.keys(dotenvVars).length > 0) {
      logger.info(`  Loaded API keys: ${Object.keys(dotenvVars).join(", ")}`)
    }
  }

  const { spawn } = await import("child_process")
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...dotenvVars } as Record<string, string>,
  })

  // Capture stderr for debugging
  let proxyStderr = ""
  child.stderr?.on("data", (chunk: Buffer) => { proxyStderr += chunk.toString() })

  // Wait for health
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await checkLitellmHealth(url)) {
      logger.info(`LiteLLM proxy ready at ${url}`)
      return child
    }
  }

  if (proxyStderr) {
    logger.warn(`LiteLLM stderr: ${proxyStderr.slice(-1000)}`)
  }
  logger.warn("LiteLLM proxy failed to start within 60s")
  child.kill()
  return null
}
