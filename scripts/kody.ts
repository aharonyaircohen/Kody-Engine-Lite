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

interface ParsedSpec { provider: string; model: string }

function parseSpec(spec: string): ParsedSpec | null {
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) return null
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }
}

function loadConfig(projectDir: string): { specs: ParsedSpec[]; primary: ParsedSpec | undefined } {
  const configPath = path.join(projectDir, "kody.config.json")
  if (!fs.existsSync(configPath)) return { specs: [], primary: undefined }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  const specs: ParsedSpec[] = []

  const pushSpec = (s: string | undefined) => {
    if (!s) return
    const p = parseSpec(s)
    if (p) specs.push(p)
  }

  for (const v of Object.values(raw.agent?.modelMap ?? {})) pushSpec(v as string)
  if (raw.agent?.default) pushSpec(raw.agent.default)
  for (const v of Object.values(raw.agent?.stages ?? {})) pushSpec(v as string)

  // Primary = agent.default > modelMap.mid > modelMap.cheap > first
  let primarySpec: string | undefined
  if (raw.agent?.default) primarySpec = raw.agent.default
  else if (raw.agent?.modelMap?.mid) primarySpec = raw.agent.modelMap.mid
  else if (raw.agent?.modelMap?.cheap) primarySpec = raw.agent.modelMap.cheap
  else primarySpec = specs[0] ? `${specs[0].provider}/${specs[0].model}` : undefined

  const primary = primarySpec ? parseSpec(primarySpec) ?? undefined : undefined
  return { specs, primary }
}

function needsProxy(primary: ParsedSpec | undefined): boolean {
  return !!primary && primary.provider !== "claude" && primary.provider !== "anthropic"
}

// ── Generate LiteLLM config YAML ────────────────────────────────────────────

function generateLitellmYaml(specs: ParsedSpec[]): string {
  const lines: string[] = ["model_list:"]
  const seen = new Set<string>()

  for (const { provider, model } of specs) {
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const apiKeyVar = `${provider.toUpperCase()}_API_KEY`
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
  const { specs, primary } = loadConfig(projectDir)

  // No proxy needed — just open Claude Code directly
  if (!needsProxy(primary)) {
    const claude = spawn("claude", forwardArgs, { stdio: "inherit", cwd: projectDir })
    claude.on("exit", (code) => process.exit(code ?? 0))
    return
  }

  console.log(`Project:  ${projectDir}`)
  console.log(`Provider: ${primary!.provider}`)
  console.log(`Model:    ${primary!.model}`)

  // Inject .env API keys
  Object.assign(process.env, loadDotenvKeys(projectDir))

  // Start LiteLLM proxy if not already running
  let litellmChild: ReturnType<typeof spawn> | null = null

  if (await checkHealth()) {
    console.log(`LiteLLM proxy already running at ${LITELLM_URL}`)
  } else {
    const yaml = generateLitellmYaml(specs)
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
  const claudeArgs = ["--model", primary!.model, "--dangerously-skip-permissions", ...forwardArgs]
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
