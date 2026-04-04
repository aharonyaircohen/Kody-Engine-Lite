#!/usr/bin/env tsx
/**
 * Run Claude Code interactively through LiteLLM proxy using a project's kody.config.json.
 *
 * Usage:
 *   pnpm claude                                        # uses ./kody.config.json
 *   pnpm claude --cwd ../Kody-Engine-Tester            # uses tester's config
 *   pnpm claude --cwd ../Kody-Engine-Tester --print "…" # one-shot prompt
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn, execFileSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LITELLM_PORT = 4000
const LITELLM_URL = `http://localhost:${LITELLM_PORT}`

// ── Parse --cwd from argv ───────────────────────────────────────────────────

function parseCwd(): { projectDir: string; forwardArgs: string[] } {
  const args = process.argv.slice(2)
  const cwdIdx = args.indexOf("--cwd")
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    const projectDir = path.resolve(args[cwdIdx + 1])
    const forwardArgs = [...args.slice(0, cwdIdx), ...args.slice(cwdIdx + 2)]
    return { projectDir, forwardArgs }
  }
  return { projectDir: process.cwd(), forwardArgs: args }
}

// ── Read kody.config.json ───────────────────────────────────────────────────

function loadConfig(projectDir: string): { provider: string | undefined; modelMap: Record<string, string> } {
  const configPath = path.join(projectDir, "kody.config.json")
  if (!fs.existsSync(configPath)) {
    return { provider: undefined, modelMap: {} }
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  return {
    provider: raw.agent?.provider,
    modelMap: raw.agent?.modelMap ?? {},
  }
}

function needsProxy(provider: string | undefined): boolean {
  return !!provider && provider !== "claude" && provider !== "anthropic"
}

// ── Generate LiteLLM config YAML ────────────────────────────────────────────

function generateLitellmYaml(provider: string, modelMap: Record<string, string>): string {
  const apiKeyVar = `${provider.toUpperCase()}_API_KEY`
  const lines: string[] = ["model_list:"]
  const seen = new Set<string>()

  for (const model of Object.values(modelMap)) {
    if (seen.has(model)) continue
    seen.add(model)
    lines.push(`  - model_name: ${model}`)
    lines.push(`    litellm_params:`)
    lines.push(`      model: ${provider}/${model}`)
    lines.push(`      api_key: os.environ/${apiKeyVar}`)
  }

  lines.push("")
  lines.push("litellm_settings:")
  lines.push("  drop_params: true")

  return lines.join("\n") + "\n"
}

// ── Load API keys from .env ─────────────────────────────────────────────────

function loadDotenvKeys(projectDir: string): Record<string, string> {
  const envPath = path.join(projectDir, ".env")
  const vars: Record<string, string> = {}
  if (!fs.existsSync(envPath)) return vars

  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*_API_KEY)=(.*)$/)
    if (!match) continue

    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) vars[match[1]] = value
  }
  return vars
}

// ── Health check ────────────────────────────────────────────────────────────

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${LITELLM_URL}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { projectDir, forwardArgs } = parseCwd()
  const { provider, modelMap } = loadConfig(projectDir)

  // No proxy needed — just open Claude Code directly
  if (!needsProxy(provider)) {
    const claude = spawn("claude", forwardArgs, { stdio: "inherit", cwd: projectDir })
    claude.on("exit", (code) => process.exit(code ?? 0))
    return
  }

  const model = modelMap.mid ?? modelMap.cheap ?? Object.values(modelMap)[0]
  console.log(`Project:  ${projectDir}`)
  console.log(`Provider: ${provider}`)
  console.log(`Model:    ${model}`)

  // Inject .env API keys
  Object.assign(process.env, loadDotenvKeys(projectDir))

  // Start LiteLLM proxy if not already running
  let litellmChild: ReturnType<typeof spawn> | null = null

  if (await checkHealth()) {
    console.log(`LiteLLM proxy already running at ${LITELLM_URL}`)
  } else {
    const yaml = generateLitellmYaml(provider!, modelMap)
    const configPath = path.join(os.tmpdir(), "kody-litellm-config.yaml")
    fs.writeFileSync(configPath, yaml)

    let cmd: string
    let args: string[]
    try {
      execFileSync("which", ["litellm"], { timeout: 3000, stdio: "pipe" })
      cmd = "litellm"
      args = ["--config", configPath, "--port", String(LITELLM_PORT)]
    } catch {
      cmd = "python3"
      args = ["-m", "litellm", "--config", configPath, "--port", String(LITELLM_PORT)]
    }

    console.log(`Starting LiteLLM proxy: ${cmd} ${args.join(" ")}`)
    console.log(`Config:\n${yaml}`)
    const proxyEnv = { ...process.env } as Record<string, string>
    delete proxyEnv.DATABASE_URL

    litellmChild = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: proxyEnv,
    })

    let proxyStderr = ""
    litellmChild.stderr?.on("data", (chunk: Buffer) => { proxyStderr += chunk.toString() })

    let ready = false
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000))
      if (await checkHealth()) { ready = true; break }
    }

    if (!ready) {
      console.error("LiteLLM proxy failed to start within 60s")
      if (proxyStderr) console.error(`Proxy stderr:\n${proxyStderr}`)
      litellmChild.kill()
      process.exit(1)
    }
    console.log(`LiteLLM proxy ready at ${LITELLM_URL}`)
  }

  // Cleanup handler
  const cleanup = () => {
    if (litellmChild) { litellmChild.kill(); litellmChild = null }
  }
  process.on("exit", cleanup)
  process.on("SIGINT", () => { cleanup(); process.exit(130) })
  process.on("SIGTERM", () => { cleanup(); process.exit(143) })

  // Run Claude Code pointed at the proxy
  const claudeArgs = ["--model", model, "--dangerously-skip-permissions", ...forwardArgs]
  console.log(`\nRunning: claude ${claudeArgs.join(" ")}`)
  console.log(`ANTHROPIC_BASE_URL=${LITELLM_URL}\n`)
  const claude = spawn("claude", claudeArgs, {
    stdio: "inherit",
    cwd: projectDir,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: LITELLM_URL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || `sk-ant-api03-${"0".repeat(64)}`,
    },
  })

  claude.on("exit", (code) => {
    cleanup()
    process.exit(code ?? 0)
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
