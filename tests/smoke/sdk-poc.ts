/**
 * Agent SDK Proof of Concept
 *
 * Tests every feature Kody needs from the SDK:
 * 1. Basic query() with model and effort
 * 2. maxTurns enforcement
 * 3. maxBudgetUsd enforcement
 * 4. allowedTools restriction (with permissionMode: 'plan')
 * 5. Sub-agent delegation with custom prompt and model
 * 6. Structured output (outputFormat)
 * 7. Per-model token usage tracking
 *
 * Run: npx tsx tests/smoke/sdk-poc.ts
 * Requires: ANTHROPIC_API_KEY env var
 */

import { query } from "@anthropic-ai/claude-agent-sdk"

const PASS = "✓"
const FAIL = "✗"
const results: { test: string; status: string; detail: string }[] = []

function log(test: string, passed: boolean, detail: string) {
  results.push({ test, status: passed ? PASS : FAIL, detail })
  console.log(`${passed ? PASS : FAIL} ${test}: ${detail}`)
}

async function test1_basicQuery() {
  console.log("\n--- Test 1: Basic query() ---")
  try {
    let output = ""
    for await (const msg of query({
      prompt: "Reply with exactly: SDK_WORKS",
      options: {
        model: "claude-haiku-4-5-20251001",
        effort: "high",
        maxTurns: 3,
        maxBudgetUsd: 0.10,
        permissionMode: "plan",
        allowedTools: [],
      },
    })) {
      if ("result" in msg) output = msg.result ?? ""
    }
    const passed = output.includes("SDK_WORKS")
    log("Basic query", passed, passed ? "Got expected response" : `Got: ${output.slice(0, 100)}`)
  } catch (e: any) {
    log("Basic query", false, `Error: ${e.message}`)
  }
}

async function test2_maxTurns() {
  console.log("\n--- Test 2: maxTurns enforcement ---")
  try {
    let terminalReason = ""
    for await (const msg of query({
      prompt:
        "Read every file in the current directory one by one. Do not stop until you have read all files.",
      options: {
        model: "claude-haiku-4-5-20251001",
        effort: "high",
        maxTurns: 2,
        maxBudgetUsd: 0.10,
        permissionMode: "plan",
        allowedTools: ["Read", "Glob"],
      },
    })) {
      if ("result" in msg) {
        terminalReason = (msg as any).terminal_reason ?? ""
      }
    }
    const passed = terminalReason === "max_turns"
    log(
      "maxTurns",
      passed,
      passed ? `Stopped at max_turns` : `terminal_reason: ${terminalReason || "(none)"}`,
    )
  } catch (e: any) {
    // SDK throws on limit hit — that IS the enforcement working
    const isLimitError = e.message?.includes("maximum number of turns")
    log("maxTurns", isLimitError, isLimitError ? "Enforced (threw on limit)" : `Error: ${e.message}`)
  }
}

async function test3_maxBudget() {
  console.log("\n--- Test 3: maxBudgetUsd enforcement ---")
  try {
    let totalCost = 0
    let terminalReason = ""
    for await (const msg of query({
      prompt: "Read every file in src/ directory recursively. Read each file completely.",
      options: {
        model: "claude-haiku-4-5-20251001",
        effort: "high",
        maxTurns: 50,
        maxBudgetUsd: 0.01,
        permissionMode: "plan",
        allowedTools: ["Read", "Glob", "Grep"],
      },
    })) {
      if ("result" in msg) {
        totalCost = (msg as any).total_cost_usd ?? 0
        terminalReason = (msg as any).terminal_reason ?? ""
      }
    }
    const passed = totalCost <= 0.02
    log(
      "maxBudgetUsd",
      passed,
      `Cost: $${totalCost.toFixed(4)}, terminal_reason: ${terminalReason || "(none)"}`,
    )
  } catch (e: any) {
    // SDK throws on budget hit — that IS the enforcement working
    const isBudgetError = e.message?.includes("maximum budget")
    log("maxBudgetUsd", isBudgetError, isBudgetError ? "Enforced (threw on limit)" : `Error: ${e.message}`)
  }
}

async function test4_allowedTools() {
  console.log("\n--- Test 4: allowedTools restriction ---")
  try {
    let output = ""
    for await (const msg of query({
      prompt:
        'Try to run this bash command: echo "SHOULD_NOT_EXECUTE". If you cannot, reply with TOOLS_RESTRICTED.',
      options: {
        model: "claude-haiku-4-5-20251001",
        effort: "high",
        maxTurns: 5,
        maxBudgetUsd: 0.10,
        permissionMode: "plan",
        allowedTools: ["Read", "Glob"],
      },
    })) {
      if ("result" in msg) output = msg.result ?? ""
    }
    const bashBlocked = !output.includes("SHOULD_NOT_EXECUTE")
    log(
      "allowedTools",
      bashBlocked,
      bashBlocked ? "Bash correctly blocked" : "Bash was NOT blocked — restriction failed",
    )
  } catch (e: any) {
    log("allowedTools", false, `Error: ${e.message}`)
  }
}

async function test5_subAgent() {
  console.log("\n--- Test 5: Sub-agent delegation ---")
  try {
    let output = ""
    let modelUsage: Record<string, any> = {}
    for await (const msg of query({
      prompt:
        "Delegate to the researcher agent to find how many TypeScript files exist in the src/ directory. Report the count.",
      options: {
        model: "claude-sonnet-4-6",
        effort: "high",
        maxTurns: 10,
        maxBudgetUsd: 0.50,
        permissionMode: "plan",
        allowedTools: ["Read", "Grep", "Glob", "Agent"],
        agents: {
          researcher: {
            description: "Explore codebase to find files and patterns",
            prompt:
              "You are a codebase explorer. Use Glob and Grep to find files. Return a count of matching files.",
            model: "haiku",
            tools: ["Read", "Grep", "Glob"],
            maxTurns: 5,
          },
        },
      },
    })) {
      if ("result" in msg) {
        output = msg.result ?? ""
        modelUsage = (msg as any).modelUsage ?? {}
      }
    }

    const models = Object.keys(modelUsage)
    const hasMultipleModels = models.length >= 2
    const hasOutput = output.length > 0

    log(
      "Sub-agent delegation",
      hasOutput,
      `Output: ${output.slice(0, 100)}...`,
    )
    log(
      "Sub-agent model routing",
      hasMultipleModels,
      hasMultipleModels
        ? `Models used: ${models.join(", ")}`
        : `Only 1 model: ${models.join(", ")}`,
    )
  } catch (e: any) {
    log("Sub-agent", false, `Error: ${e.message}`)
  }
}

async function test6_structuredOutput() {
  console.log("\n--- Test 6: Structured JSON output ---")
  try {
    let parsed: any = null
    let rawResult = ""
    for await (const msg of query({
      prompt:
        'Classify this task: "Add unit tests for the auth module".',
      options: {
        model: "claude-sonnet-4-6",
        effort: "high",
        maxTurns: 3,
        maxBudgetUsd: 0.50,
        permissionMode: "plan",
        allowedTools: [],
        outputFormat: {
          type: "json_schema" as const,
          schema: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["feature", "bugfix", "refactor", "docs", "test"],
              },
              risk: { type: "string", enum: ["low", "medium", "high"] },
              summary: { type: "string" },
            },
            required: ["type", "risk", "summary"],
          },
        },
      },
    })) {
      const m = msg as any
      if (m.type === "result") {
        rawResult = m.result ?? ""
        // Structured output lives in structured_output, not result
        if (m.structured_output) {
          parsed = m.structured_output
        }
      }
    }

    if (!parsed) {
      // Try parsing raw result as JSON fallback
      try {
        parsed = JSON.parse(rawResult)
      } catch {
        log("Structured output", false, `No structured_output field and raw result not JSON: ${rawResult.slice(0, 80)}`)
        return
      }
    }

    const hasType = ["feature", "bugfix", "refactor", "docs", "test"].includes(parsed.type)
    const hasRisk = ["low", "medium", "high"].includes(parsed.risk)
    const hasSummary = typeof parsed.summary === "string" && parsed.summary.length > 0
    const passed = hasType && hasRisk && hasSummary

    log(
      "Structured output",
      passed,
      passed
        ? `type=${parsed.type}, risk=${parsed.risk}, summary=${parsed.summary.slice(0, 50)}`
        : `Missing fields: type=${hasType}, risk=${hasRisk}, summary=${hasSummary}`,
    )
  } catch (e: any) {
    log("Structured output", false, `Error: ${e.message}`)
  }
}

async function main() {
  console.log("=== Kody Engine — Agent SDK Proof of Concept ===\n")

  await test1_basicQuery()
  await test2_maxTurns()
  await test3_maxBudget()
  await test4_allowedTools()
  await test5_subAgent()
  await test6_structuredOutput()

  console.log("\n=== Summary ===")
  console.log("─".repeat(60))
  for (const r of results) {
    console.log(`${r.status} ${r.test.padEnd(30)} ${r.detail.slice(0, 60)}`)
  }
  console.log("─".repeat(60))

  const passed = results.filter((r) => r.status === PASS).length
  const total = results.length
  console.log(`\n${passed}/${total} tests passed`)

  process.exit(passed === total ? 0 : 1)
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
