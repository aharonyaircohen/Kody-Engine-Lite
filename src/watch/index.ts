/**
 * Entry point for Kody Watch — periodic health monitoring + LLM-powered watch agents.
 */

import * as fs from "fs"
import * as path from "path"
import type { ChildProcess } from "child_process"

import { runWatch } from "./core/watch.js"
import { createPluginRegistry } from "./plugins/registry.js"
import { loadWatchAgents } from "./agents/loader.js"
import { checkLitellmHealth, tryStartLitellm, generateLitellmConfigFromStages } from "../cli/litellm.js"
import { LITELLM_DEFAULT_URL, parseProviderModel } from "../config.js"
import type { WatchConfig } from "./core/types.js"

export interface WatchConfigParsed {
  repo: string
  activityLog?: number
  /** "provider/model" string from watch.model (or fallback). */
  watchModel?: string
  /** Tier → "provider/model" string. */
  agentModelMap?: Record<string, string>
}

export function parseWatchConfig(cwd: string): WatchConfigParsed {
  const configPath = path.join(cwd, "kody.config.json")
  let repo = process.env.REPO || ""
  let activityLog: number | undefined
  let watchModel: string | undefined
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

  return { repo, activityLog, watchModel, agentModelMap }
}

export async function runWatchCommand(opts: { dryRun: boolean; agent?: string }): Promise<void> {
  const cwd = process.cwd()
  let litellmProcess: ChildProcess | null = null

  const { repo: parsedRepo, activityLog, watchModel, agentModelMap } = parseWatchConfig(cwd)
  let repo = parsedRepo

  if (!repo) {
    console.error("Missing repo — set REPO env var or configure github.owner/repo in kody.config.json")
    process.exit(1)
  }

  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.error("Missing GH_TOKEN or GITHUB_TOKEN")
    process.exit(1)
  }

  // Register deterministic plugins (e.g. system-health, performance-monitor)
  const registry = createPluginRegistry()

  // Discover watch agents
  const { agents, warnings } = loadWatchAgents(cwd)
  for (const w of warnings) {
    console.warn(`  Agent warning: ${w}`)
  }

  // Resolve watch model: watch.model > agent.modelMap.watch > agent.modelMap.cheap > any
  const resolvedSpec = watchModel
    ?? agentModelMap?.watch
    ?? agentModelMap?.cheap
    ?? (agentModelMap ? Object.values(agentModelMap)[0] : undefined)
    ?? ""
  if (agents.length > 0 && !resolvedSpec) {
    console.error("No watch model configured — set watch.model or agent.modelMap in kody.config.json (format: 'provider/model')")
    process.exit(1)
  }

  // Parse provider and bare model name out of the "provider/model" string.
  let provider: string | undefined
  let model = resolvedSpec
  if (resolvedSpec) {
    const parsed = parseProviderModel(resolvedSpec)
    provider = parsed.provider
    model = parsed.model
  }
  const needsProxy = provider !== undefined && provider !== "claude" && provider !== "anthropic"

  if (agents.length > 0) {
    console.log(`  Found ${agents.length} watch agent(s): ${agents.map((a) => a.config.name).join(", ")}`)
    console.log(`  Model: ${model}${provider ? ` (provider: ${provider})` : ""}`)

    // Start LiteLLM proxy if needed for non-claude providers
    if (needsProxy && !opts.dryRun) {
      const litellmUrl = LITELLM_DEFAULT_URL
      const isHealthy = await checkLitellmHealth(litellmUrl)
      if (!isHealthy) {
        // Build the proxy model list: parse modelMap entries + the watch model itself.
        const proxyModels: { provider: string; model: string }[] = []
        if (agentModelMap) {
          for (const value of Object.values(agentModelMap)) {
            try { proxyModels.push(parseProviderModel(value)) } catch { /* skip malformed */ }
          }
        }
        proxyModels.push({ provider: provider!, model })
        const generatedConfig = generateLitellmConfigFromStages(proxyModels)
        console.log(`  Starting LiteLLM proxy for ${provider}...`)
        litellmProcess = await tryStartLitellm(litellmUrl, cwd, generatedConfig)
        if (litellmProcess) {
          console.log(`  LiteLLM proxy started`)
        } else {
          console.warn(`  LiteLLM proxy failed to start — agents using ${provider} may fail`)
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
    provider,
    projectDir: cwd,
    agentFilter: opts.agent,
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
    console.log(`\nCycle #${result.cycleNumber} complete: ${result.agentsRun} watch agents, ${result.actionsExecuted} actions, ${result.actionsDeduplicated} deduplicated`)
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
