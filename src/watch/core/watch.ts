/**
 * Main Watch loop — orchestrates plugins, agents, dedup, execution, and state.
 */

import type { ActionRequest, WatchConfig, WatchContext, WatchResult, WatchAgentRunResult } from "./types.js"
import { createStateStore } from "./state.js"
import { shouldDedup, markExecuted, cleanupExpiredDedup } from "./dedup.js"
import { createGitHubClient } from "../clients/github.js"
import { createConsoleLogger } from "../clients/logger.js"
import { runWatchAgent } from "../agents/run-agent.js"
import { shouldRunOnCycle } from "./schedule.js"

export async function runWatch(config: WatchConfig): Promise<WatchResult> {
  const { repo, dryRun, stateFile, plugins, agents } = config

  const token = process.env.GH_TOKEN || ""
  const github = createGitHubClient(repo, token)

  const state = createStateStore(stateFile, github, config.activityLog)
  const cycleNumber = (state.get<number>("system:cycleNumber") || 0) + 1
  state.set("system:cycleNumber", cycleNumber)
  const log = createConsoleLogger()
  const timestamp = new Date().toISOString()

  const ctx: WatchContext = {
    repo,
    dryRun,
    state,
    github,
    log,
    runTimestamp: timestamp,
    cycleNumber,
    projectDir: config.projectDir,
    activityLog: config.activityLog,
  }

  const cleaned = cleanupExpiredDedup(ctx)
  if (cleaned > 0) {
    log.debug({ cleaned }, "Cleaned up expired dedup entries")
  }

  const errors: string[] = []
  const allActions: ActionRequest[] = []

  // ── Deterministic plugins ──────────────────────────────────────────────────

  const scheduledPlugins = plugins.filter((plugin) => {
    if (!plugin.schedule || !plugin.schedule.everyHours) return true
    return cycleNumber % plugin.schedule.everyHours === 0
  })

  log.info(
    { cycle: cycleNumber, pluginsTotal: plugins.length, pluginsScheduled: scheduledPlugins.length },
    "Watch cycle started",
  )

  for (const plugin of scheduledPlugins) {
    try {
      log.debug({ plugin: plugin.name }, "Running plugin")
      const actions = await plugin.run(ctx)
      allActions.push(...actions)
      log.debug({ plugin: plugin.name, actionCount: actions.length }, "Plugin completed")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`Plugin ${plugin.name}: ${message}`)
      log.error({ plugin: plugin.name, error: message }, "Plugin failed")
    }
  }

  // Deduplicate
  const dedupedActions: ActionRequest[] = []
  let actionsDeduplicated = 0

  for (const action of allActions) {
    if (shouldDedup(action, ctx)) {
      actionsDeduplicated++
      log.debug(
        { plugin: action.plugin, type: action.type, dedupKey: action.dedupKey },
        "Action deduplicated",
      )
      continue
    }
    dedupedActions.push(action)
  }

  // Execute plugin actions
  let actionsExecuted = 0

  if (!dryRun) {
    for (const action of dedupedActions) {
      try {
        log.info(
          { plugin: action.plugin, type: action.type, target: action.target, urgency: action.urgency },
          "Executing action",
        )
        const result = await action.execute(ctx)
        if (result.success) {
          actionsExecuted++
          markExecuted(action, ctx)
        } else {
          log.warn({ plugin: action.plugin, type: action.type, message: result.message }, "Action failed")
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`Action ${action.plugin}/${action.type}: ${message}`)
        log.error({ plugin: action.plugin, type: action.type, error: message }, "Action error")
      }
    }
  } else {
    log.info({ actionCount: dedupedActions.length }, "Dry run — skipping action execution")
  }

  // ── Watch agents (LLM-powered) ────────────────────────────────────────────

  const scheduledAgents = agents.filter((agent) => {
    const now = new Date(ctx.runTimestamp)
    return shouldRunOnCycle(agent.config.schedule, cycleNumber, state, now)
  })

  const agentResults: WatchAgentRunResult[] = []

  if (scheduledAgents.length > 0 && !dryRun) {
    log.info(
      { agentsTotal: agents.length, agentsScheduled: scheduledAgents.length },
      "Running watch agents",
    )

    // Provider comes from agent.provider in kody.config.json (via WatchConfig)
    const provider = config.provider

    for (const agent of scheduledAgents) {
      try {
        log.info({ agent: agent.config.name }, "Running watch agent")
        const result = await runWatchAgent(agent, ctx, {
          model: config.model,
          provider,
          projectDir: config.projectDir,
          timeoutMs: agent.config.timeoutMs,
        })
        agentResults.push(result)

        // Fallback reporting: post agent output to activity log when agent didn't complete
        if (agent.config.reportOnFailure && ctx.activityLog && result.outcome !== "completed") {
          const header = `## Watch Agent: ${agent.config.name} — ${result.outcome}`
          const content = result.error
            ? `${header}\n\n**Error:** ${result.error}`
            : result.output
              ? `${header}\n\n<details><summary>Agent output</summary>\n\n${result.output.slice(0, 60000)}\n\n</details>`
              : header
          try {
            ctx.github.postComment(ctx.activityLog, content)
          } catch {
            log.warn({ agent: agent.config.name }, "Failed to post agent result to activity log")
          }
        }

        if (result.outcome === "completed") {
          log.info({ agent: agent.config.name }, "Watch agent completed")
        } else {
          const errMsg = `Agent ${agent.config.name}: ${result.outcome}${result.error ? ` — ${result.error}` : ""}`
          errors.push(errMsg)
          log.warn({ agent: agent.config.name, outcome: result.outcome }, "Watch agent did not complete")
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`Agent ${agent.config.name}: ${message}`)
        log.error({ agent: agent.config.name, error: message }, "Watch agent failed")
        agentResults.push({ agentName: agent.config.name, outcome: "failed", error: message })
      }
    }
  } else if (scheduledAgents.length > 0 && dryRun) {
    log.info(
      { agentCount: scheduledAgents.length },
      "Dry run — skipping watch agent execution",
    )
  }

  state.save()

  const result: WatchResult = {
    cycleNumber,
    pluginsRun: scheduledPlugins.length,
    actionsProduced: allActions.length,
    actionsExecuted,
    actionsDeduplicated,
    agentsRun: scheduledAgents.length,
    agentResults,
    errors,
  }

  log.info(
    {
      cycle: cycleNumber,
      pluginsRun: result.pluginsRun,
      actionsProduced: result.actionsProduced,
      actionsExecuted: result.actionsExecuted,
      actionsDeduplicated: result.actionsDeduplicated,
      agentsRun: result.agentsRun,
      errors: result.errors.length,
    },
    "Watch cycle completed",
  )

  return result
}
