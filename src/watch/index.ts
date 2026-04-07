/**
 * Entry point for Kody Watch — periodic health monitoring + LLM-powered watch agents.
 */

import * as fs from "fs"
import * as path from "path"
import type { ChildProcess } from "child_process"

import { runWatch } from "./core/watch.js"
import { createPluginRegistry } from "./plugins/registry.js"
import { pipelineHealthPlugin } from "./plugins/pipeline-health/index.js"
import { securityScanPlugin } from "./plugins/security-scan/index.js"
import { configHealthPlugin } from "./plugins/config-health/index.js"
import { loadWatchAgents } from "./agents/loader.js"
import { checkLitellmHealth, tryStartLitellm, generateLitellmConfig } from "../cli/litellm.js"
import { LITELLM_DEFAULT_URL } from "../config.js"
import type { WatchConfig } from "./core/types.js"

export interface WatchConfigParsed {
  repo: string
  activityLog?: number
  watchModel?: string
  agentProvider?: string
  agentModelMap?: Record<string, string>
}

export function parseWatchConfig(cwd: string): WatchConfigParsed {
  const configPath = path.join(cwd, "kody.config.json")
  let repo = process.env.REPO || ""
  let activityLog: number | undefined
  let watchModel: string | undefined
  let agentProvider: string | undefined
  let agentModelMap: Record<string, string> | undefined

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      if (!repo && config.github?.owner && config.github?.repo) {
        repo = `${config.github.owner}/${config.github.repo}`
      }
      if (config.watch?.activityLog) {
        activityLog = config.watch.activityLog
      }
      if (config.watch?.model) {
        watchModel = config.watch.model
      }
      if (config.agent?.provider) {
        agentProvider = config.agent.provider
      }
      if (config.agent?.modelMap) {
        agentModelMap = config.agent.modelMap
      }
    } catch {
      // Can't read config
    }
  }

  // Env override for activity log (backward compat: read both env var names)
  const activityLogEnv = process.env.WATCH_ACTIVITY_LOG ?? process.env.WATCH_DIGEST_ISSUE
  if (activityLogEnv) {
    activityLog = parseInt(activityLogEnv, 10) || undefined
  }

  return { repo, activityLog, watchModel, agentProvider, agentModelMap }
}

export async function runWatchCommand(opts: { dryRun: boolean }): Promise<void> {
  const cwd = process.cwd()
  let litellmProcess: ChildProcess | null = null

  const { repo: parsedRepo, activityLog, watchModel, agentProvider, agentModelMap } = parseWatchConfig(cwd)
  let repo = parsedRepo

  if (!repo) {
    console.error("Missing repo — set REPO env var or configure github.owner/repo in kody.config.json")
    process.exit(1)
  }

  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.error("Missing GH_TOKEN or GITHUB_TOKEN")
    process.exit(1)
  }

  // Register deterministic plugins
  const registry = createPluginRegistry()
  registry.register(pipelineHealthPlugin)
  registry.register(securityScanPlugin)
  registry.register(configHealthPlugin)

  // Discover watch agents
  const { agents, warnings } = loadWatchAgents(cwd)
  for (const w of warnings) {
    console.warn(`  Agent warning: ${w}`)
  }

  // Resolve watch model: watch.model > agent.modelMap.watch > agent.modelMap.default > fallback
  const resolvedModel = watchModel
    ?? agentModelMap?.watch
    ?? agentModelMap?.default
    ?? ""
  if (agents.length > 0 && !resolvedModel) {
    console.error("No watch model configured — set watch.model or agent.modelMap in kody.config.json")
    process.exit(1)
  }
  const model = resolvedModel
  const needsProxy = agentProvider && agentProvider !== "claude" && agentProvider !== "anthropic"

  if (agents.length > 0) {
    console.log(`  Found ${agents.length} watch agent(s): ${agents.map((a) => a.config.name).join(", ")}`)
    console.log(`  Model: ${model}${agentProvider ? ` (provider: ${agentProvider})` : ""}`)

    // Start LiteLLM proxy if needed for non-claude providers
    if (needsProxy && !opts.dryRun) {
      const litellmUrl = LITELLM_DEFAULT_URL
      const isHealthy = await checkLitellmHealth(litellmUrl)
      if (!isHealthy) {
        // Build a model map that includes the watch model
        const proxyModelMap = { ...agentModelMap, watch: model }
        const generatedConfig = generateLitellmConfig(agentProvider!, proxyModelMap)
        console.log(`  Starting LiteLLM proxy for ${agentProvider}...`)
        litellmProcess = await tryStartLitellm(litellmUrl, cwd, generatedConfig)
        if (litellmProcess) {
          console.log(`  LiteLLM proxy started`)
        } else {
          console.warn(`  LiteLLM proxy failed to start — agents using ${agentProvider} may fail`)
        }
      } else {
        console.log(`  LiteLLM proxy already running`)
      }
    }
  }

  const config: WatchConfig = {
    repo,
    dryRun: opts.dryRun,
    stateFile: path.join(cwd, ".kody", "watch-state.json"),
    plugins: registry.getAll(),
    activityLog,
    agents,
    model,
    provider: agentProvider,
    projectDir: cwd,
  }

  console.log(`\nKody Watch — repo: ${repo}, dry-run: ${opts.dryRun}\n`)

  try {
    const result = await runWatch(config)

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        console.warn(`  Warning: ${error}`)
      }
    }

    const agentSummary = result.agentsRun > 0
      ? `, ${result.agentsRun} agents`
      : ""
    console.log(`\nCycle #${result.cycleNumber} complete: ${result.pluginsRun} plugins${agentSummary}, ${result.actionsExecuted} actions, ${result.actionsDeduplicated} deduplicated`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Watch failed: ${message}`)
  } finally {
    if (litellmProcess) {
      litellmProcess.kill("SIGTERM")
    }
    process.exit(0)
  }
}
