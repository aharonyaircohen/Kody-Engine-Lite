import * as fs from "fs"
import * as path from "path"
import { createRunners } from "./agent-runner.js"
import { runPipeline, printStatus } from "./pipeline.js"
import { runPreflight } from "./preflight.js"
import { setConfigDir, getProjectConfig } from "./config.js"
import { setGhCwd, getIssue, postComment } from "./github-api.js"
import { logger } from "./logger.js"
import type { PipelineContext } from "./types.js"

// Extracted modules
import { parseArgs } from "./cli/args.js"
import { checkLitellmHealth, tryStartLitellm } from "./cli/litellm.js"
import { generateTaskId } from "./cli/task-resolution.js"
import { resolveForIssue } from "./cli/task-state.js"


async function main() {
  const input = parseArgs()

  // Resolve working directory first (needed for task lookup)
  const projectDir = input.cwd ? path.resolve(input.cwd) : process.cwd()
  if (input.cwd) {
    if (!fs.existsSync(projectDir)) {
      console.error(`--cwd path does not exist: ${projectDir}`)
      process.exit(1)
    }
    setConfigDir(projectDir)
    setGhCwd(projectDir)
    logger.info(`Working directory: ${projectDir}`)
  }

  // Resolve task via state machine
  let taskId = input.taskId
  if (!taskId) {
    if (input.issueNumber) {
      const taskAction = resolveForIssue(input.issueNumber, projectDir)
      logger.info(`Task action: ${taskAction.action}`)

      if (taskAction.action === "already-completed") {
        logger.info(`Issue #${input.issueNumber} already completed (task ${taskAction.taskId})`)
        if (!input.local) {
          try {
            postComment(input.issueNumber, `✅ Issue #${input.issueNumber} already completed (task \`${taskAction.taskId}\`)`)
          } catch { /* best effort */ }
        }
        process.exit(0)
      }

      if (taskAction.action === "already-running") {
        logger.info(`Issue #${input.issueNumber} already running (task ${taskAction.taskId})`)
        if (!input.local) {
          try {
            postComment(input.issueNumber, `⏳ Pipeline already running for issue #${input.issueNumber} (task \`${taskAction.taskId}\`)`)
          } catch { /* best effort */ }
        }
        process.exit(0)
      }

      taskId = taskAction.taskId
      if (taskAction.action === "resume") {
        input.fromStage = taskAction.fromStage
        input.command = "rerun" as "rerun"
        logger.info(`Resuming task ${taskId} from ${taskAction.fromStage}`)
      }
    } else if (input.command === "run" && input.task) {
      taskId = generateTaskId()
    } else {
      console.error("--task-id is required (or provide --issue-number to auto-generate)")
      process.exit(1)
    }
  }

  const taskDir = path.join(projectDir, ".tasks", taskId)
  fs.mkdirSync(taskDir, { recursive: true })

  // Status command — no preflight needed
  if (input.command === "status") {
    printStatus(taskId, taskDir)
    return
  }

  // Preflight
  logger.info("Preflight checks:")
  runPreflight()

  // Write task.md if --task provided
  if (input.task) {
    fs.writeFileSync(path.join(taskDir, "task.md"), input.task)
  }

  // Auto-fetch issue body as task if no task.md and issue-number provided
  const taskMdPath = path.join(taskDir, "task.md")
  if (!fs.existsSync(taskMdPath) && input.issueNumber) {
    logger.info(`Fetching issue #${input.issueNumber} body as task...`)
    const issue = getIssue(input.issueNumber)
    if (issue) {
      const taskContent = `# ${issue.title}\n\n${issue.body ?? ""}`
      fs.writeFileSync(taskMdPath, taskContent)
      logger.info(`  Task loaded from issue #${input.issueNumber}: ${issue.title}`)
    }
  }

  // Verify task.md exists
  if (!fs.existsSync(taskMdPath)) {
    console.error("No task.md found. Provide --task, --issue-number, or ensure .tasks/<id>/task.md exists.")
    process.exit(1)
  }

  // Fix command defaults to --from build
  if (input.command === "fix" && !input.fromStage) {
    input.fromStage = "build"
  }

  // Start LiteLLM proxy if configured and not running
  const config = getProjectConfig()
  let litellmProcess: { kill: () => void } | null = null
  const cleanupLitellm = () => { if (litellmProcess) { litellmProcess.kill(); litellmProcess = null } }
  process.on("exit", cleanupLitellm)
  process.on("SIGINT", () => { cleanupLitellm(); process.exit(130) })
  process.on("SIGTERM", () => { cleanupLitellm(); process.exit(143) })

  if (config.agent.litellmUrl) {
    const proxyRunning = await checkLitellmHealth(config.agent.litellmUrl)
    if (!proxyRunning) {
      litellmProcess = await tryStartLitellm(config.agent.litellmUrl, projectDir)
      if (!litellmProcess) {
        logger.warn("LiteLLM not available — falling back to Anthropic models")
        config.agent.litellmUrl = undefined
      }
    } else {
      logger.info(`LiteLLM proxy already running at ${config.agent.litellmUrl}`)
    }
  }

  // Create runners
  const runners = createRunners(config)
  const defaultRunnerName = config.agent.defaultRunner ?? Object.keys(runners)[0] ?? "claude"
  const defaultRunner = runners[defaultRunnerName]
  if (!defaultRunner) {
    console.error(`Default runner "${defaultRunnerName}" not configured`)
    process.exit(1)
  }
  const healthy = await defaultRunner.healthCheck()
  if (!healthy) {
    console.error(`Runner "${defaultRunnerName}" health check failed`)
    process.exit(1)
  }

  // Build context
  const ctx: PipelineContext = {
    taskId,
    taskDir,
    projectDir,
    runners,
    input: {
      mode: (input.command === "rerun" || input.command === "fix") ? "rerun" : "full",
      fromStage: input.fromStage,
      dryRun: input.dryRun,
      issueNumber: input.issueNumber,
      feedback: input.feedback,
      local: input.local,
      complexity: input.complexity,
    },
  }

  logger.info(`Task: ${taskId}`)
  logger.info(`Mode: ${ctx.input.mode}${ctx.input.local ? " (local)" : " (CI)"}`)
  if (ctx.input.issueNumber) logger.info(`Issue: #${ctx.input.issueNumber}`)

  // Post task-id comment so user knows the ID for rerun
  if (ctx.input.issueNumber && !ctx.input.local && ctx.input.mode === "full") {
    const runUrl = process.env.RUN_URL ?? ""
    const runLink = runUrl ? ` ([logs](${runUrl}))` : ""
    try {
      postComment(
        ctx.input.issueNumber,
        `🚀 Kody pipeline started: \`${taskId}\`${runLink}\n\nTo rerun: \`@kody rerun ${taskId} --from <stage>\``,
      )
    } catch { /* best effort */ }
  }

  // Run pipeline
  const state = await runPipeline(ctx)

  // Report
  const files = fs.readdirSync(taskDir)
  console.log(`\nArtifacts in ${taskDir}:`)
  for (const f of files) {
    console.log(`  ${f}`)
  }

  if (state.state === "failed") {
    // Check if this is a "paused" state (questions posted) — not a real failure
    const isPaused = Object.values(state.stages).some(
      (s) => s.error?.includes("paused") ?? false,
    )

    if (isPaused) {
      process.exit(0)
    }

    // Post failure comment on issue
    if (ctx.input.issueNumber && !ctx.input.local) {
      const failedStage = Object.entries(state.stages).find(
        ([, s]) => s.state === "failed" || s.state === "timeout",
      )
      const stageName = failedStage ? failedStage[0] : "unknown"
      const error = failedStage ? failedStage[1].error ?? "" : ""
      try {
        postComment(
          ctx.input.issueNumber,
          `❌ Pipeline failed at **${stageName}**${error ? `: ${error.slice(0, 200)}` : ""}`,
        )
      } catch {
        // Best effort
      }
    }
    process.exit(1)
  }

  // Explicitly exit on success — the detached LiteLLM process keeps the event loop alive
  cleanupLitellm()
  process.exit(0)
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)

  // Post crash comment if we have issue context
  const issueStr = process.argv.find((_, i, a) => a[i - 1] === "--issue-number") ?? process.env.ISSUE_NUMBER
  const isLocal = process.argv.includes("--local") || !process.env.GITHUB_ACTIONS
  if (issueStr && !isLocal) {
    try {
      postComment(parseInt(issueStr, 10), `❌ Pipeline crashed: ${msg.slice(0, 200)}`)
    } catch {
      // Best effort
    }
  }

  process.exit(1)
})
