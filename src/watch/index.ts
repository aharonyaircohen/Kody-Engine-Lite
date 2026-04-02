/**
 * Entry point for Kody Watch — periodic health monitoring.
 */

import * as fs from "fs"
import * as path from "path"

import { runWatch } from "./core/watch.js"
import { createPluginRegistry } from "./plugins/registry.js"
import { pipelineHealthPlugin } from "./plugins/pipeline-health/index.js"
import { securityScanPlugin } from "./plugins/security-scan/index.js"
import { configHealthPlugin } from "./plugins/config-health/index.js"
import type { WatchConfig } from "./core/types.js"

export async function runWatchCommand(opts: { dryRun: boolean }): Promise<void> {
  const cwd = process.cwd()

  // Read repo from config
  const configPath = path.join(cwd, "kody.config.json")
  let repo = process.env.REPO || ""
  let digestIssue: number | undefined

  if (!repo && fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      if (config.github?.owner && config.github?.repo) {
        repo = `${config.github.owner}/${config.github.repo}`
      }
      if (config.watch?.digestIssue) {
        digestIssue = config.watch.digestIssue
      }
    } catch {
      // Can't read config
    }
  }

  // Env override for digest issue
  if (process.env.WATCH_DIGEST_ISSUE) {
    digestIssue = parseInt(process.env.WATCH_DIGEST_ISSUE, 10) || undefined
  }

  if (!repo) {
    console.error("Missing repo — set REPO env var or configure github.owner/repo in kody.config.json")
    process.exit(1)
  }

  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.error("Missing GH_TOKEN or GITHUB_TOKEN")
    process.exit(1)
  }

  // Register plugins
  const registry = createPluginRegistry()
  registry.register(pipelineHealthPlugin)
  registry.register(securityScanPlugin)
  registry.register(configHealthPlugin)

  const config: WatchConfig = {
    repo,
    dryRun: opts.dryRun,
    stateFile: path.join(cwd, ".kody", "watch-state.json"),
    plugins: registry.getAll(),
    digestIssue,
  }

  console.log(`\nKody Watch — repo: ${repo}, dry-run: ${opts.dryRun}\n`)

  try {
    const result = await runWatch(config)

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        console.warn(`  Warning: ${error}`)
      }
    }

    console.log(`\nCycle #${result.cycleNumber} complete: ${result.pluginsRun} plugins, ${result.actionsExecuted} actions, ${result.actionsDeduplicated} deduplicated`)
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Watch failed: ${message}`)
    process.exit(1)
  }
}
