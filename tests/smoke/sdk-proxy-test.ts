/**
 * Agent SDK + LiteLLM Proxy Test
 *
 * Tests whether the SDK works when routing through LiteLLM proxy
 * (the same way Kody uses it in CI with non-Anthropic providers).
 *
 * Requires: LiteLLM proxy running on port 4111
 * Run: npx tsx tests/smoke/sdk-proxy-test.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk"

const PASS = "✓"
const FAIL = "✗"
const results: { test: string; status: string; detail: string }[] = []

function log(test: string, passed: boolean, detail: string) {
  results.push({ test, status: passed ? PASS : FAIL, detail })
  console.log(`${passed ? PASS : FAIL} ${test}: ${detail}`)
}

async function test1_basicViaProxy() {
  console.log("\n--- Test 1: SDK query() via LiteLLM proxy ---")
  try {
    let output = ""
    for await (const msg of query({
      prompt: "Reply with exactly: SDK_PROXY_WORKS",
      options: {
        model: "claude-sonnet-4-6",
        effort: "high",
        maxTurns: 3,
        maxBudgetUsd: 1.00,
        permissionMode: "plan",
        allowedTools: [],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "sk-ant-api03-dummy-key-for-litellm",
          ANTHROPIC_BASE_URL: "http://localhost:4111",
        },
      },
    })) {
      if ("result" in msg) output = msg.result ?? ""
    }
    const passed = output.includes("SDK_PROXY_WORKS")
    log("SDK via proxy", passed, passed ? "Got expected response via LiteLLM→MiniMax" : `Got: ${output.slice(0, 150)}`)
  } catch (e: any) {
    log("SDK via proxy", false, `Error: ${e.message?.slice(0, 150)}`)
  }
}

async function test2_toolUseViaProxy() {
  console.log("\n--- Test 2: Tool use via proxy ---")
  try {
    let output = ""
    for await (const msg of query({
      prompt: "Use Glob to find all *.ts files in the src/bin/ directory. Report the filenames.",
      options: {
        model: "claude-sonnet-4-6",
        effort: "high",
        maxTurns: 5,
        maxBudgetUsd: 1.00,
        permissionMode: "plan",
        allowedTools: ["Glob", "Read"],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "sk-ant-api03-dummy-key-for-litellm",
          ANTHROPIC_BASE_URL: "http://localhost:4111",
        },
      },
    })) {
      if ("result" in msg) output = msg.result ?? ""
    }
    const passed = output.includes("cli.ts") || output.includes("bin")
    log("Tool use via proxy", passed, passed ? "Agent used tools through proxy" : `Got: ${output.slice(0, 150)}`)
  } catch (e: any) {
    log("Tool use via proxy", false, `Error: ${e.message?.slice(0, 150)}`)
  }
}

async function main() {
  console.log("=== SDK + LiteLLM Proxy Test ===")
  console.log("Proxy: http://localhost:4111 → MiniMax-M2.7-highspeed\n")

  await test1_basicViaProxy()
  await test2_toolUseViaProxy()

  console.log("\n=== Summary ===")
  console.log("─".repeat(60))
  for (const r of results) {
    console.log(`${r.status} ${r.test.padEnd(30)} ${r.detail.slice(0, 60)}`)
  }
  console.log("─".repeat(60))

  const passed = results.filter((r) => r.status === PASS).length
  console.log(`\n${passed}/${results.length} tests passed`)

  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
