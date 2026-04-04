/**
 * Runs a watch agent using the existing AgentRunner (Claude Code CLI + LiteLLM).
 */

import { createClaudeCodeRunner } from "../../agent-runner.js"
import { getLitellmUrl, stageNeedsProxy } from "../../config.js"
import type { WatchAgentDefinition, WatchAgentRunResult, WatchContext } from "../core/types.js"
import { buildWatchAgentPrompt } from "./prompt-builder.js"

/** Default timeout for a watch agent run (2 minutes) */
const AGENT_TIMEOUT_MS = 2 * 60 * 1000

export interface RunAgentOptions {
  model: string
  provider?: string
  projectDir: string
  timeoutMs?: number
}

export async function runWatchAgent(
  agent: WatchAgentDefinition,
  ctx: WatchContext,
  options: RunAgentOptions,
): Promise<WatchAgentRunResult> {
  const { model, provider, projectDir, timeoutMs = AGENT_TIMEOUT_MS } = options

  const prompt = buildWatchAgentPrompt(agent, {
    repo: ctx.repo,
    cycleNumber: ctx.cycleNumber,
    digestIssue: ctx.digestIssue,
  })

  const runner = createClaudeCodeRunner()

  // Route through LiteLLM proxy if provider is non-claude
  const extraEnv: Record<string, string> = {}
  const stageConfig = { provider: provider ?? "claude", model }
  if (stageNeedsProxy(stageConfig)) {
    extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
    // Claude Code CLI requires ANTHROPIC_API_KEY to start.
    // Provide a dummy so CLI launches — LiteLLM handles real auth.
    if (!process.env.ANTHROPIC_API_KEY) {
      extraEnv.ANTHROPIC_API_KEY = `sk-ant-api03-${"0".repeat(64)}`
    }
  }

  const result = await runner.run(
    `watch:${agent.config.name}`,
    prompt,
    model,
    timeoutMs,
    projectDir,
    {
      cwd: projectDir,
      env: extraEnv,
    },
  )

  return {
    agentName: agent.config.name,
    outcome: result.outcome,
    output: result.output,
    error: result.error,
  }
}
