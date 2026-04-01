/**
 * `kody test-model --provider <provider> --model <model> --key <key>`
 *
 * Tests LLM provider/model compatibility with Claude Code / Kody pipeline.
 * Starts a LiteLLM proxy, runs 14 compatibility tests, prints a report.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"

import { logger } from "../logger.js"
import { checkLitellmHealth } from "./litellm.js"
import { ALL_TESTS } from "./test-model-tests.js"
import { formatReport } from "./test-model-report.js"
import type { TestReport, TestResult } from "./test-model-report.js"

// ── Constants ────────────────────────────────────────────────────────────────

const TEST_PORT = 4099
const TEST_URL = `http://localhost:${TEST_PORT}`
const CONFIG_PATH = path.join(os.tmpdir(), "kody-test-model-config.yaml")

// ── Types ────────────────────────────────────────────────────────────────────

interface TestModelOptions {
  provider: string
  model: string
  apiKey: string
  proxyUrl: string
  skipProxy: boolean
  filter?: string[]
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseTestModelArgs(): TestModelOptions {
  const args = process.argv.slice(3) // skip node, cli.ts, "test-model"

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag)
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
    return undefined
  }
  const hasFlag = (f: string) => args.includes(f)

  if (hasFlag("--help") || hasFlag("-h")) {
    logger.info([
      "Usage: kody test-model --provider <provider> --model <model> --key <api-key> [options]",
      "",
      "Options:",
      "  --provider     LLM provider name (e.g. gemini, openai, claude)",
      "  --model        Model identifier (e.g. gemini-2.5-flash, claude-sonnet-4-6)",
      "  --key          API key (optional for claude/anthropic — uses CLI auth)",
      "  --key-env      Read API key from this environment variable",
      "  --skip-proxy   Use an already-running LiteLLM proxy (don't start one)",
      "  --litellm-url  LiteLLM proxy URL (default: http://localhost:4099)",
      "  --filter       Comma-separated test names to run (default: all)",
      "  --list         List all available tests and exit",
    ].join("\n"))
    process.exit(0)
  }

  if (hasFlag("--list")) {
    for (const t of ALL_TESTS) {
      logger.info(`  ${t.name.padEnd(24)} [${t.category}] ${t.description}`)
    }
    process.exit(0)
  }

  const provider = getArg("--provider")
  const model = getArg("--model")
  const key = getArg("--key")
  const keyEnv = getArg("--key-env")

  if (!provider || !model) {
    logger.error("Required: --provider <provider> --model <model> --key <key>")
    logger.error("Run with --help for usage.")
    process.exit(1)
  }

  const isDirectAnthropic = provider === "claude" || provider === "anthropic"

  let apiKey = key
  if (!apiKey && keyEnv) apiKey = process.env[keyEnv]
  if (!apiKey && !isDirectAnthropic) {
    logger.error("API key required: use --key <value> or --key-env <ENV_VAR>")
    logger.error("(For claude/anthropic provider, --key is optional — uses Claude Code auth)")
    process.exit(1)
  }

  return {
    provider,
    model,
    apiKey: apiKey ?? "",
    proxyUrl: isDirectAnthropic ? "https://api.anthropic.com" : (getArg("--litellm-url") ?? TEST_URL),
    skipProxy: isDirectAnthropic || hasFlag("--skip-proxy"),
    filter: getArg("--filter")?.split(","),
  }
}

// ── LiteLLM config generation ────────────────────────────────────────────────

function generateConfig(provider: string, model: string, dropParams: boolean): string {
  const lines: string[] = []
  if (dropParams) {
    lines.push("litellm_settings:")
    lines.push("  drop_params: true")
    lines.push("")
  }
  lines.push("model_list:")
  lines.push(`  - model_name: ${model}`)
  lines.push("    litellm_params:")
  lines.push(`      model: ${provider}/${model}`)
  lines.push("      api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY")
  return lines.join("\n") + "\n"
}

// ── Proxy management ─────────────────────────────────────────────────────────

async function startProxy(
  config: string,
  url: string,
): Promise<ReturnType<typeof import("child_process").spawn> | null> {
  // Check litellm is installed
  try {
    execFileSync("which", ["litellm"], { timeout: 3000, stdio: "pipe" })
  } catch {
    try {
      execFileSync("python3", ["-c", "import litellm"], { timeout: 10000, stdio: "pipe" })
    } catch {
      logger.error("litellm not installed. Install: pip install 'litellm[proxy]'")
      return null
    }
  }

  fs.writeFileSync(CONFIG_PATH, config)
  const portMatch = url.match(/:(\d+)/)
  const port = portMatch ? portMatch[1] : "4099"

  const { spawn } = await import("child_process")
  const child = spawn("litellm", ["--config", CONFIG_PATH, "--port", port], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env as Record<string, string>,
  })

  // Wait for health
  for (let i = 0; i < 30; i++) {
    await delay(2000)
    if (await checkLitellmHealth(url)) {
      logger.info(`LiteLLM proxy ready at ${url}`)
      return child
    }
  }

  child.kill()
  return null
}

async function quickApiTest(url: string, model: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Include context_management — Claude Code always sends this parameter.
    // If the proxy doesn't have drop_params, this request will fail for non-Anthropic models.
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: "Say ok" }],
        context_management: { policy: "smart" },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, error: body.slice(0, 200) }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runTestModelCommand(): Promise<void> {
  const opts = parseTestModelArgs()
  const startTime = Date.now()

  logger.info(`Testing model compatibility: ${opts.provider}/${opts.model}`)
  logger.info("")

  let proxyProcess: ReturnType<typeof import("child_process").spawn> | null = null
  let dropParamsRequired = false

  const cleanup = () => {
    if (proxyProcess) { proxyProcess.kill(); proxyProcess = null }
    fs.rmSync(CONFIG_PATH, { force: true })
  }
  process.on("SIGINT", () => { cleanup(); process.exit(1) })
  process.on("SIGTERM", () => { cleanup(); process.exit(1) })

  try {
    if (!opts.skipProxy) {
      // Set API key for LiteLLM
      process.env.ANTHROPIC_COMPATIBLE_API_KEY = opts.apiKey

      // Phase 1: Try without drop_params
      logger.info("Starting LiteLLM proxy (without drop_params)...")
      proxyProcess = await startProxy(generateConfig(opts.provider, opts.model, false), opts.proxyUrl)
      if (!proxyProcess) {
        logger.error("Failed to start LiteLLM proxy")
        process.exit(1)
      }

      const quickRes = await quickApiTest(opts.proxyUrl, opts.model, opts.apiKey)
      if (!quickRes.ok) {
        logger.info("Model needs drop_params: true -- restarting proxy...")
        proxyProcess.kill()
        proxyProcess = null
        await delay(2000)

        proxyProcess = await startProxy(generateConfig(opts.provider, opts.model, true), opts.proxyUrl)
        dropParamsRequired = true
        if (!proxyProcess) {
          logger.error("Failed to start LiteLLM proxy with drop_params")
          process.exit(1)
        }

        const retry = await quickApiTest(opts.proxyUrl, opts.model, opts.apiKey)
        if (!retry.ok) {
          logger.error(`Model not accessible: ${retry.error}`)
          process.exit(1)
        }
        logger.info("Proxy restarted with drop_params: true")
      } else {
        logger.info("drop_params not required")
      }
    } else {
      logger.info(`Using existing proxy at ${opts.proxyUrl}`)
    }

    // Phase 2: Run tests
    const tests = opts.filter
      ? ALL_TESTS.filter(t => opts.filter!.includes(t.name))
      : ALL_TESTS

    logger.info(`Running ${tests.length} compatibility tests...`)
    logger.info("")

    const ctx = { proxyUrl: opts.proxyUrl, model: opts.model, apiKey: opts.apiKey, projectDir: process.cwd() }
    const results: TestResult[] = []

    for (const test of tests) {
      process.stdout.write(`  ${test.name.padEnd(28)} `)
      try {
        const r = await test.run(ctx)
        results.push(r)
        const icon = r.status === "pass" ? "+" : r.status === "fail" ? "x" : "!"
        logger.info(`[${icon}] ${r.status.toUpperCase()} ${r.accuracy}% (${(r.durationMs / 1000).toFixed(1)}s)`)
      } catch (err) {
        const r: TestResult = {
          name: test.name,
          category: test.category,
          status: "fail",
          accuracy: 0,
          durationMs: 0,
          detail: `Crash: ${err instanceof Error ? err.message : String(err)}`,
        }
        results.push(r)
        logger.info("[x] CRASH")
      }
    }

    // Phase 3: Report
    const report: TestReport = {
      provider: opts.provider,
      model: opts.model,
      results,
      totalDurationMs: Date.now() - startTime,
      dropParamsRequired,
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    }

    console.log("")
    console.log(formatReport(report))

    const failed = results.filter(r => r.status === "fail").length
    process.exit(failed > 0 ? 1 : 0)
  } finally {
    cleanup()
  }
}
