import * as fs from "fs"
import * as path from "path"
import { createRunners } from "./agent-runner.js"
import { runPipeline, printStatus } from "./pipeline.js"
import { runPreflight } from "./preflight.js"
import { setConfigDir, getProjectConfig } from "./config.js"
import { setGhCwd, getIssue, postComment, getPRDetails, getPRsForIssue, postPRComment, submitPRReview, getLatestKodyReviewComment, getCIFailureLogs, getLatestFailedRunForBranch, getPRFeedbackSinceLastKodyAction } from "./github-api.js"
import { logger } from "./logger.js"
import type { PipelineContext } from "./types.js"
import { runStandaloneReview, resolveReviewTarget, formatReviewComment, detectReviewVerdict } from "./review-standalone.js"

// Extracted modules
import { parseArgs } from "./cli/args.js"
import { checkLitellmHealth, checkModelHealth, tryStartLitellm, generateLitellmConfig, generateLitellmConfigFromStages } from "./cli/litellm.js"
import { generateTaskId } from "./cli/task-resolution.js"
import { resolveForIssue } from "./cli/task-state.js"
import { needsLitellmProxy, anyStageNeedsProxy, getLitellmUrl, providerApiKeyEnvVar } from "./config.js"
import type { KodyConfig } from "./config.js"

async function ensureLitellmProxy(
  config: KodyConfig,
  projectDir: string,
): Promise<{ kill: () => void } | null> {
  // Check if any stage needs the proxy (new per-stage config or legacy provider)
  if (!anyStageNeedsProxy(config)) return null

  const litellmUrl = getLitellmUrl()
  const proxyRunning = await checkLitellmHealth(litellmUrl)

  let litellmProcess: ReturnType<typeof import("child_process").spawn> | null = null
  if (!proxyRunning) {
    // Check provider API key before starting
    if (config.agent.provider && config.agent.provider !== "anthropic") {
      const keyVar = providerApiKeyEnvVar(config.agent.provider)
      if (!process.env[keyVar]) {
        logger.error(`Provider '${config.agent.provider}' requires ${keyVar} environment variable`)
        process.exit(1)
      }
    }

    // Generate LiteLLM config: prefer per-stage configs, fall back to legacy modelMap
    let generatedConfig: string | undefined
    if (config.agent.stages || config.agent.default) {
      generatedConfig = generateLitellmConfigFromStages(config.agent.default, config.agent.stages)
    } else if (config.agent.provider && config.agent.provider !== "anthropic") {
      generatedConfig = generateLitellmConfig(config.agent.provider, config.agent.modelMap)
    }

    litellmProcess = await tryStartLitellm(litellmUrl, projectDir, generatedConfig)
    if (!litellmProcess) {
      logger.error("LiteLLM is configured but could not be started. Install it with: pip install 'litellm[proxy]'")
      process.exit(1)
    }
  } else {
    logger.info(`LiteLLM proxy already running at ${litellmUrl}`)
  }

  // Don't set ANTHROPIC_BASE_URL globally — per-stage agent.ts sets it only when needed
  logger.info(`LiteLLM proxy available at ${litellmUrl}`)

  // Claude Code CLI requires ANTHROPIC_API_KEY to start.
  // If not set, provide a dummy so CLI launches (LiteLLM handles real auth).
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"0".repeat(64)}`
  }

  return litellmProcess
}

async function runModelHealthCheck(config: KodyConfig): Promise<void> {
  const usesProxy = needsLitellmProxy(config)
  const baseUrl = usesProxy ? getLitellmUrl() : "https://api.anthropic.com"
  const apiKey = usesProxy
    ? process.env.ANTHROPIC_COMPATIBLE_API_KEY
    : process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    const keyName = usesProxy ? "ANTHROPIC_COMPATIBLE_API_KEY" : "ANTHROPIC_API_KEY"
    logger.warn(`Skipping model health check — ${keyName} not set`)
    return
  }

  const model = config.agent.modelMap.cheap
  logger.info(`Model health check (${model} via ${usesProxy ? "LiteLLM" : "Anthropic"})...`)

  const result = await checkModelHealth(baseUrl, apiKey, model)
  if (result.ok) {
    logger.info("  ✓ Model responded")
  } else {
    logger.error(`  ✗ Model health check failed: ${result.error}`)
    process.exit(1)
  }
}

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

  // State machine: check issue state before doing anything
  // Skip for review/resolve/rerun commands and for PR-based fix (these don't need issue resolution)
  const isPRFix = (input.command === "fix" || input.command === "fix-ci") && !!input.prNumber
  const skipStateCheck = input.command === "review" || input.command === "resolve" || input.command === "rerun"
  if (input.issueNumber && !skipStateCheck && !isPRFix) {
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

    if (taskAction.action === "resume") {
      // Merge resume state without mutating the original parsed args
      Object.assign(input, {
        taskId: taskAction.taskId,
        fromStage: taskAction.fromStage,
        command: "rerun" as const,
      })
      logger.info(`Resuming task ${taskAction.taskId} from ${taskAction.fromStage}`)
    }
  }

  // Resolve taskId
  let taskId = input.taskId
  if (!taskId) {
    if (isPRFix) {
      taskId = `${input.command === "fix-ci" ? "fixci" : "fix"}-pr-${input.prNumber}-${generateTaskId()}`
    } else if (input.issueNumber) {
      taskId = `${input.issueNumber}-${generateTaskId()}`
    } else if (input.command === "run" && input.task) {
      taskId = generateTaskId()
    } else if (input.command === "review") {
      taskId = input.prNumber ? `review-pr-${input.prNumber}-${generateTaskId()}` : `review-${generateTaskId()}`
    } else {
      console.error("--task-id is required (or provide --issue-number to auto-generate)")
      process.exit(1)
    }
  }

  const taskDir = path.join(projectDir, ".kody", "tasks", taskId)
  fs.mkdirSync(taskDir, { recursive: true })

  // Status command — no preflight needed
  if (input.command === "status") {
    printStatus(taskId, taskDir)
    return
  }

  // Review command — standalone review, no full pipeline
  if (input.command === "review") {
    runPreflight()

    // Resolve which PR to review
    let prTitle = "Code review"
    let prBody = ""
    let baseBranch: string | undefined
    let prNumber: number | undefined = input.prNumber

    if (!prNumber && input.issueNumber) {
      // Find PRs for this issue
      const prs = getPRsForIssue(input.issueNumber)
      const target = resolveReviewTarget({ issueNumber: input.issueNumber, prs })

      if (target.action === "none" || target.action === "pick") {
        console.log(target.message)
        if (!input.local && input.issueNumber) {
          try { postComment(input.issueNumber, target.message) } catch { /* best effort */ }
        }
        process.exit(target.action === "none" ? 1 : 0)
      }

      prNumber = target.prNumber
    }

    if (prNumber) {
      const details = getPRDetails(prNumber)
      if (details) {
        prTitle = details.title
        prBody = details.body ?? ""
        baseBranch = details.baseBranch
      }
    }

    const config = getProjectConfig()
    const litellmProcess = await ensureLitellmProxy(config, projectDir)
    await runModelHealthCheck(config)

    const runners = createRunners(config)
    const defaultRunnerName = config.agent.defaultRunner ?? Object.keys(runners)[0] ?? "claude"
    const defaultRunner = runners[defaultRunnerName]
    if (!defaultRunner) { console.error(`Default runner "${defaultRunnerName}" not configured`); process.exit(1) }
    const healthy = await defaultRunner.healthCheck()
    if (!healthy) { console.error(`Runner "${defaultRunnerName}" health check failed`); process.exit(1) }

    const result = await runStandaloneReview({
      projectDir,
      runners,
      prTitle,
      prBody,
      baseBranch,
      local: input.local ?? true,
      taskId,
    })

    if (litellmProcess) litellmProcess.kill()

    if (result.outcome === "failed") {
      console.error(`Review failed: ${result.error}`)
      process.exit(1)
    }

    // Output: console for CLI, PR comment + PR review for CI
    if (result.reviewContent) {
      console.log(result.reviewContent)

      if (!input.local && prNumber) {
        const comment = formatReviewComment(result.reviewContent, taskId)

        // Submit as a GitHub PR review (approve or request-changes)
        // Falls back to a plain comment if the review fails (e.g., can't approve own PR)
        const verdict = detectReviewVerdict(result.reviewContent)
        const event = verdict === "fail" ? "request-changes" : "approve"
        const posted = submitPRReview(prNumber, comment, event)
        if (!posted) {
          postPRComment(prNumber, comment)
        }
      }
    }

    process.exit(0)
  }

  // Resolve command — merge default branch + resolve conflicts
  if (input.command === "resolve") {
    if (!input.prNumber) {
      console.error("--pr-number is required for resolve command")
      process.exit(1)
    }

    runPreflight()

    const config = getProjectConfig()
    const litellmProcess = await ensureLitellmProxy(config, projectDir)
    await runModelHealthCheck(config)

    const runners = createRunners(config)
    const defaultRunnerName = config.agent.defaultRunner ?? Object.keys(runners)[0] ?? "claude"
    const defaultRunner = runners[defaultRunnerName]
    if (!defaultRunner) { console.error(`Default runner "${defaultRunnerName}" not configured`); process.exit(1) }
    const healthy = await defaultRunner.healthCheck()
    if (!healthy) { console.error(`Runner "${defaultRunnerName}" health check failed`); process.exit(1) }

    const { runResolve } = await import("./resolve.js")
    const result = await runResolve({
      prNumber: input.prNumber,
      projectDir,
      runners,
      local: input.local ?? true,
    })

    if (litellmProcess) litellmProcess.kill()

    if (result.outcome === "failed") {
      console.error(`Resolve failed: ${result.error}`)
      process.exit(1)
    }

    console.log(`Resolve: ${result.outcome}`)
    process.exit(0)
  }

  // Preflight
  logger.info("Preflight checks:")
  runPreflight()

  // Write task.md if --task provided
  if (input.task) {
    fs.writeFileSync(path.join(taskDir, "task.md"), input.task)
  }

  // Auto-fetch task context: PR details for PR-based fix, issue body otherwise
  const taskMdPath = path.join(taskDir, "task.md")
  if (!fs.existsSync(taskMdPath) && isPRFix && input.prNumber) {
    logger.info(`Fetching PR #${input.prNumber} details as task context...`)
    const prDetails = getPRDetails(input.prNumber)
    if (prDetails) {
      const taskContent = `# ${prDetails.title}\n\n${prDetails.body ?? ""}`
      fs.writeFileSync(taskMdPath, taskContent)
      logger.info(`  Task loaded from PR #${input.prNumber}: ${prDetails.title}`)
    }
  } else if (!fs.existsSync(taskMdPath) && input.issueNumber) {
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
    console.error("No task.md found. Provide --task, --issue-number, or ensure .kody/tasks/<id>/task.md exists.")
    process.exit(1)
  }

  // Fix command defaults to --from build
  if ((input.command === "fix" || input.command === "fix-ci") && !input.fromStage) {
    input.fromStage = "build"
  }

  // Fix-CI on a PR: fetch CI failure logs as context
  if (input.command === "fix-ci" && input.prNumber) {
    // Resolve CI run ID from arg, feedback body, or latest failed run
    let ciRunId = input.ciRunId
    if (!ciRunId && input.feedback) {
      const match = input.feedback.match(/Run ID:\s*(\d+)/)
      ciRunId = match?.[1]
    }
    if (!ciRunId) {
      const prDetails = getPRDetails(input.prNumber)
      if (prDetails) {
        ciRunId = getLatestFailedRunForBranch(prDetails.headBranch) ?? undefined
      }
    }
    if (ciRunId) {
      const ciLogs = getCIFailureLogs(ciRunId)
      if (ciLogs) {
        logger.info(`  Found CI failure logs for run ${ciRunId}, injecting as feedback`)
        const ciContext = `## CI Failure Logs (run ${ciRunId})\n\nThe CI pipeline failed. Fix the code to make CI pass.\n\n\`\`\`\n${ciLogs}\n\`\`\``
        input.feedback = input.feedback
          ? `${ciContext}\n\n## Additional context\n\n${input.feedback}`
          : ciContext
      }
    }
  }

  // Fix on a PR: auto-fetch Kody review + human comments as context
  if (input.command === "fix" && input.prNumber) {
    const feedbackParts: string[] = []

    // Kody's own review findings
    const reviewComment = getLatestKodyReviewComment(input.prNumber)
    if (reviewComment) {
      logger.info(`  Found Kody review comment on PR #${input.prNumber}`)
      feedbackParts.push(`## Review findings from PR #${input.prNumber}\n\n${reviewComment}`)
    }

    // Human comments since the last Kody action (scoped to current fix cycle)
    const humanFeedback = getPRFeedbackSinceLastKodyAction(input.prNumber)
    if (humanFeedback) {
      logger.info(`  Found human feedback on PR #${input.prNumber}`)
      feedbackParts.push(`## Human review feedback from PR #${input.prNumber}\n\n${humanFeedback}`)
    }

    // Explicit feedback from the @kody fix comment body
    if (input.feedback) {
      feedbackParts.push(`## Additional feedback\n\n${input.feedback}`)
    }

    if (feedbackParts.length > 0) {
      input.feedback = feedbackParts.join("\n\n")
    }
  }

  const config = getProjectConfig()

  // Apply per-stage timeout overrides from config
  if (config.timeouts) {
    const { applyTimeoutOverrides } = await import("./definitions.js")
    applyTimeoutOverrides(config.timeouts)
  }

  let litellmProcess = await ensureLitellmProxy(config, projectDir)
  await runModelHealthCheck(config)
  const cleanupLitellm = () => { if (litellmProcess) { litellmProcess.kill(); litellmProcess = null } }
  process.on("exit", cleanupLitellm)
  process.on("SIGINT", () => { cleanupLitellm(); process.exit(130) })
  process.on("SIGTERM", () => { cleanupLitellm(); process.exit(143) })

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

  // Resolve PR base branch for sync (avoids merging wrong branch, e.g. kody vs dev)
  let prBaseBranch: string | undefined
  if (input.prNumber) {
    const prDetails = getPRDetails(input.prNumber)
    if (prDetails) {
      prBaseBranch = prDetails.baseBranch
    }
  }

  // Build context
  const ctx: PipelineContext = {
    taskId,
    taskDir,
    projectDir,
    runners,
    input: {
      mode: (input.command === "rerun" || input.command === "fix" || input.command === "fix-ci") ? "rerun" : "full",
      fromStage: input.fromStage,
      dryRun: input.dryRun,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      prBaseBranch,
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
