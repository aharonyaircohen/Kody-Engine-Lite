/**
 * Runs a watch agent using the existing AgentRunner (Claude Code CLI + LiteLLM).
 */

import { createClaudeCodeRunner } from "../../agent-runner.js"
import { getLitellmUrl, stageNeedsProxy, getAnthropicApiKeyOrDummy } from "../../config.js"
import type { WatchAgentDefinition, WatchAgentRunResult, WatchContext } from "../core/types.js"
import { buildWatchAgentPrompt } from "./prompt-builder.js"
import { join } from "path"

/** Default timeout for a watch agent run (20 minutes) */
const AGENT_TIMEOUT_MS = 20 * 60 * 1000

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
    activityLog: ctx.activityLog,
  })

  const runner = createClaudeCodeRunner()

  // Route through LiteLLM proxy if provider is non-claude
  const extraEnv: Record<string, string> = {}
  if (!provider) throw new Error(`Watch agent '${agent.config.name}' is missing provider — set watch.model to 'provider/model' in kody.config.json`)

  const stageConfig = { provider, model }
  if (stageNeedsProxy(stageConfig)) {
    extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
    extraEnv.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  // Persist session transcript for debugging
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const agentLogFile = join(projectDir, ".kody", "watch", "agent-logs", `${agent.config.name}-${timestamp}.log`)

  const result = await runner.run(
    `watch:${agent.config.name}`,
    prompt,
    model,
    timeoutMs,
    projectDir,
    {
      cwd: projectDir,
      env: extraEnv,
      agentLogFile,
    },
  )

  return {
    agentName: agent.config.name,
    outcome: result.outcome,
    output: result.output,
    error: result.error,
  }
}
