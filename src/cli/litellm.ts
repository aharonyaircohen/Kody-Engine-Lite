import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"

import { logger } from "../logger.js"
import { providerApiKeyEnvVar } from "../config.js"

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
  model: string,
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
    // Accept Anthropic format (any text block in content array) or OpenAI format
    const hasAnthropicContent = Array.isArray(body.content) && body.content.some((b: { type?: string }) => b.type === "text")
    const hasThinkingContent = Array.isArray(body.content) && body.content.some((b: { type?: string }) => b.type === "thinking")
    const hasOpenAIContent = !!body.choices?.[0]?.message?.content
    if (!hasAnthropicContent && !hasThinkingContent && !hasOpenAIContent) {
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
  modelMap: Record<string, string>,
): string {
  const apiKeyVar = providerApiKeyEnvVar(provider)
  const entries: string[] = ["model_list:"]

  // Deduplicate: multiple tiers may map to the same provider model
  const seen = new Set<string>()
  for (const providerModel of Object.values(modelMap)) {
    if (seen.has(providerModel)) continue
    seen.add(providerModel)
    // Map the config model name directly — this is what resolveModel() returns
    entries.push(`  - model_name: ${providerModel}`)
    entries.push(`    litellm_params:`)
    entries.push(`      model: ${provider}/${providerModel}`)
    entries.push(`      api_key: os.environ/${apiKeyVar}`)
  }

  return entries.join("\n") + "\n"
}

/**
 * Generate LiteLLM config from per-stage configs.
 * Only includes models that use non-claude providers.
 */
export function generateLitellmConfigFromStages(
  defaultConfig: { provider: string; model: string } | undefined,
  stages: Record<string, { provider: string; model: string }> | undefined,
): string | undefined {
  const proxyModels: { provider: string; model: string }[] = []

  // Collect all non-claude models
  if (defaultConfig && defaultConfig.provider !== "claude" && defaultConfig.provider !== "anthropic") {
    proxyModels.push(defaultConfig)
  }
  if (stages) {
    for (const sc of Object.values(stages)) {
      if (sc.provider !== "claude" && sc.provider !== "anthropic") {
        proxyModels.push(sc)
      }
    }
  }

  if (proxyModels.length === 0) return undefined

  const entries: string[] = ["model_list:"]
  const seen = new Set<string>()

  for (const { provider, model } of proxyModels) {
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const apiKeyVar = providerApiKeyEnvVar(provider)
    entries.push(`  - model_name: ${model}`)
    entries.push(`    litellm_params:`)
    entries.push(`      model: ${provider}/${model}`)
    entries.push(`      api_key: os.environ/${apiKeyVar}`)
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
    for (const rawLine of fs.readFileSync(dotenvPath, "utf-8").split("\n")) {
      const line = rawLine.trim()
      // Skip comments and empty lines
      if (!line || line.startsWith("#")) continue
      const match = line.match(/^([A-Z_][A-Z0-9_]*_API_KEY)=(.*)$/)
      if (match) {
        let value = match[2].trim()
        // Strip surrounding quotes (single or double)
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        // Strip inline comments (unquoted)
        const commentIdx = value.indexOf(" #")
        if (commentIdx !== -1) value = value.slice(0, commentIdx).trim()
        if (value) dotenvVars[match[1]] = value
      }
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
