import * as fs from "fs"
import * as path from "path"
import { createRunners } from "./agent-runner.js"
import { runPipeline, printStatus, formatStatus } from "./pipeline.js"
import { runPreflight } from "./preflight.js"
import { setConfigDir, getProjectConfig, applyModelOverrides } from "./config.js"
import { setGhCwd, getIssue, postComment, getPRDetails, getPRsForIssue, postPRComment, submitPRReview, getLatestKodyReviewComment, getCIFailureLogs, getLatestFailedRunForBranch, getPRFeedbackSinceLastKodyAction, setLifecycleLabel, setLabel } from "./github-api.js"
import { logger } from "./logger.js"
import type { PipelineContext } from "./types.js"
import { runStandaloneReview, resolveReviewTarget, formatReviewComment, detectReviewVerdict } from "./review-standalone.js"

// Extracted modules
import { parseArgs } from "./cli/args.js"
import { checkLitellmHealth, checkModelHealth, tryStartLitellm, generateLitellmConfig, generateLitellmConfigFromStages } from "./cli/litellm.js"
import { generateTaskId, resolveTaskIdForCommand } from "./cli/task-resolution.js"
import { resolveForIssue } from "./cli/task-state.js"
import { isTaskifyRun, taskifyCommand, readTaskifyMarker } from "./cli/taskify-command.js"
import { needsLitellmProxy, anyStageNeedsProxy, getLitellmUrl, providerApiKeyEnvVar, getAnthropicApiKeyOrDummy } from "./config.js"
import type { KodyConfig } from "./config.js"
import { loadToolDeclarations, detectTools } from "./tools.js"
import { findParentRunId } from "./run-history.js"
import { resolveIssueFromPR } from "./cli/task-resolution.js"

// Extract fatal-error cleanup to share between SIGTERM, unhandledRejection, and main().catch()
export function handleFatalError(label: string, msg?: string): void {
  const issueStr = process.argv.find((_, i, a) => a[i - 1] === "--issue-number") ?? process.env.ISSUE_NUMBER
  const isLocal = process.argv.includes("--local") || !process.env.GITHUB_ACTIONS
  if (issueStr && !isLocal) {
    const issueNumber = parseInt(issueStr, 10)
    try { postComment(issueNumber, label) } catch { /* best effort */ }
    try { setLabel(issueNumber, "kody:failed") } catch { /* best effort */ }
  }
  if (msg) console.error(msg)
}

// Handle SIGTERM (sent by GitHub Actions on job cancel/timeout)
process.on("SIGTERM", () => {
  handleFatalError("❌ Pipeline killed (job timeout or cancellation)")
  process.exit(143)
})

// Handle unhandled promise rejections — prevent silent crashes that skip cleanup
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  handleFatalError(`❌ Pipeline crashed (unhandled rejection): ${msg.slice(0, 200)}`)
  process.exit(1)
})

const MAX_LITELLM_RETRIES = 3

async function startLitellmWithRetry(
  litellmUrl: string,
  projectDir: string,
  generatedConfig?: string,
): Promise<ReturnType<typeof tryStartLitellm>> {
  for (let attempt = 1; attempt <= MAX_LITELLM_RETRIES; attempt++) {
    const process = await tryStartLitellm(litellmUrl, projectDir, generatedConfig)
    if (process) return process
    if (attempt < MAX_LITELLM_RETRIES) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000)
      logger.info(`  LiteLLM start attempt ${attempt} failed — retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  logger.error(
    `LiteLLM failed to start after ${MAX_LITELLM_RETRIES} attempts. ` +
    "Install it with: pip install 'litellm[proxy]'",
  )
  process.exit(1)
}

async function ensureLitellmProxy(
  config: KodyConfig,
  projectDir: string,
): Promise<{ kill: () => void } | null> {
  // Check if any stage needs the proxy (new per-stage config or legacy provider)
  if (!anyStageNeedsProxy(config)) return null

  const litellmUrl = getLitellmUrl()
  const proxyRunning = await checkLitellmHealth(litellmUrl)

  // Generate LiteLLM config: prefer per-stage configs, fall back to legacy modelMap
  let generatedConfig: string | undefined
  if (config.agent.stages || config.agent.default) {
    generatedConfig = generateLitellmConfigFromStages(config.agent.default, config.agent.stages)
  } else if (config.agent.provider && config.agent.provider !== "anthropic") {
    generatedConfig = generateLitellmConfig(config.agent.provider, config.agent.modelMap)
  }

  let litellmProcess: ReturnType<typeof import("child_process").spawn> | null = null
  if (proxyRunning) {
    // Proxy is running — verify it has the models we need, restart if stale
    const needsRestart = await isProxyStale(litellmUrl, config)
    if (needsRestart) {
      logger.info("LiteLLM proxy has stale model config — restarting with updated models")
      await killExistingProxy(litellmUrl)
      litellmProcess = await startLitellmWithRetry(litellmUrl, projectDir, generatedConfig)
    } else {
      logger.info(`LiteLLM proxy already running at ${litellmUrl}`)
    }
  } else {
    litellmProcess = await startLitellmWithRetry(litellmUrl, projectDir, generatedConfig)
  }

  // Don't set ANTHROPIC_BASE_URL globally — per-stage agent.ts sets it only when needed
  logger.info(`LiteLLM proxy available at ${litellmUrl}`)

  // Claude Code CLI requires ANTHROPIC_API_KEY to start.
  // If not set, provide a dummy so CLI launches (LiteLLM handles real auth).
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  return litellmProcess
}

/**
 * Check if the running LiteLLM proxy has stale model config.
 * Queries the proxy's /v1/models endpoint and compares against expected models.
 */
async function isProxyStale(url: string, config: KodyConfig): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return true
    const body = await res.json() as { data?: Array<{ id: string }> }
    const available = new Set((body.data ?? []).map((m) => m.id))

    // Collect all models the engine needs
    const needed = new Set<string>()
    for (const model of Object.values(config.agent.modelMap)) {
      needed.add(model)
    }
    if (config.agent.default?.model) needed.add(config.agent.default.model)
    if (config.agent.stages) {
      for (const sc of Object.values(config.agent.stages)) {
        needed.add(sc.model)
      }
    }

    // If any needed model is missing from the proxy, it's stale
    for (const model of needed) {
      if (!available.has(model)) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * Kill an existing LiteLLM proxy process.
 * Finds the litellm/python process by name to avoid killing the engine itself.
 */
async function killExistingProxy(_url: string): Promise<void> {
  try {
    const { execSync } = await import("child_process")
    // Kill litellm process by name, not by port — avoids accidentally killing the engine
    execSync(`pkill -9 -f 'litellm.*--config' 2>/dev/null || true`, { stdio: "pipe" })
    // Wait for port to be released
    await new Promise((resolve) => setTimeout(resolve, 2000))
  } catch {
    // Best effort
  }
}

async function runModelHealthCheck(config: KodyConfig): Promise<void> {
  const usesProxy = anyStageNeedsProxy(config)
  const baseUrl = usesProxy ? getLitellmUrl() : "https://api.anthropic.com"

  // When using LiteLLM proxy, the proxy handles auth — the provider's API key
  // lives in the proxy's environment, not the engine's. Use a dummy key for the
  // health check request since LiteLLM ignores the x-api-key header.
  let apiKey: string
  if (usesProxy) {
    apiKey = "health-check"
  } else {
    const provider = config.agent.default?.provider ?? config.agent.provider ?? "anthropic"
    const keyName = providerApiKeyEnvVar(provider)
    apiKey = process.env[keyName] ?? ""
    if (!apiKey) {
      logger.warn(`Skipping model health check — ${keyName} not set`)
      return
    }
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

  // Apply CLI --provider / --model overrides before any command branch reads config
  if (input.provider || input.model) {
    const config = getProjectConfig()
    applyModelOverrides(config, input.provider, input.model)
    logger.info(`CLI override: provider=${config.agent.default?.provider} model=${config.agent.default?.model}`)
  }

  // State machine: check issue state before doing anything
  // Skip for review/resolve/rerun commands and for PR-based fix (these don't need issue resolution)
  const isPRFix = (input.command === "fix" || input.command === "fix-ci") && !!input.prNumber
  const skipStateCheck = input.command === "review" || input.command === "resolve" || input.command === "rerun" || input.command === "status" || input.command === "compose" || input.command === "ask"
  if (input.issueNumber && !skipStateCheck && !isPRFix) {
    const taskAction = resolveForIssue(input.issueNumber, projectDir)
    logger.info(`Task action: ${taskAction.action}`)

    if (taskAction.action === "already-completed") {
      logger.info(`Issue #${input.issueNumber} already completed (task ${taskAction.taskId}) — skipping silently`)
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
  let wasAutoResolved = false
  if (!taskId) {
    // For rerun/status: auto-resolve from .kody/tasks/ or issue comments
    // In CI (GitHub Actions), the GitHub API comment is the authoritative source —
    // the local .kody/tasks/ may not contain the task if the pipeline ran on a PR branch.
    if ((input.command === "rerun" || input.command === "status") && input.issueNumber) {
      wasAutoResolved = true
      const isCI = process.env.GITHUB_ACTIONS === "true"
      const resolved = resolveTaskIdForCommand(input.issueNumber, projectDir, isCI)
      if (resolved) {
        taskId = resolved
        logger.info(`Auto-resolved task-id: ${taskId} (from issue #${input.issueNumber})`)
      } else {
        console.error(`No task found for issue #${input.issueNumber}. Provide --task-id explicitly.`)
        process.exit(1)
      }
    } else if (isPRFix) {
      taskId = `${input.command === "fix-ci" ? "fixci" : "fix"}-pr-${input.prNumber}-${generateTaskId()}`
    } else if (input.issueNumber) {
      taskId = `${input.issueNumber}-${generateTaskId()}`
    } else if (input.command === "run" && input.task) {
      taskId = generateTaskId()
    } else if (input.command === "review") {
      taskId = input.prNumber ? `review-pr-${input.prNumber}-${generateTaskId()}` : `review-${generateTaskId()}`
    } else if (input.command === "ask") {
      taskId = `ask-${input.issueNumber ?? generateTaskId()}`
    } else {
      console.error("--task-id is required (or provide --issue-number to auto-generate)")
      process.exit(1)
    }
  }

  const taskDir = path.join(projectDir, ".kody", "tasks", taskId)
  fs.mkdirSync(taskDir, { recursive: true })

  // Taskify approve/resume — re-dispatch to taskifyCommand with feedback
  if (input.command === "rerun" && isTaskifyRun(taskDir)) {
    const marker = readTaskifyMarker(taskDir)
    if (marker) {
      logger.info(`Resuming taskify run for ${marker.ticketId ?? marker.prdFile} with PM feedback`)
      await taskifyCommand({
        ticketId: marker.ticketId,
        prdFile: marker.prdFile,
        issueNumber: marker.issueNumber ?? input.issueNumber,
        feedback: input.feedback,
        local: input.local,
        projectDir,
        taskId,
      })
      return
    }
  }

  // Status command — no preflight needed
  if (input.command === "status") {
    const statusText = formatStatus(taskId, taskDir, projectDir, input.issueNumber)
    if (statusText) {
      console.log(statusText)
      // Post status as issue comment in CI so users see it without digging into logs
      if (!input.local && input.issueNumber) {
        try {
          postComment(input.issueNumber, `## Pipeline Status\n\n${statusText}`)
        } catch { /* best effort */ }
      }
    } else {
      console.log(`No status found for task ${taskId}`)
    }
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

  // Chat command — handled directly by cli.ts; entry.ts just validates the command exists
  if (input.command === "chat") {
    process.exit(0)
  }

  // Ask command — research and answer a question
  if (input.command === "ask") {
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

    const { runAsk } = await import("./commands/ask.js")
    const result = await runAsk({
      issueNumber: input.issueNumber,
      question: input.feedback ?? "",
      projectDir,
      runners,
      taskId,
      local: input.local,
    })

    if (litellmProcess) litellmProcess.kill()

    if (result.outcome === "failed") {
      console.error(`Ask failed: ${result.error}`)
      process.exit(1)
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

  // Decompose command — parallel sub-task execution
  if (input.command === "decompose") {
    if (!input.issueNumber) {
      console.error("--issue-number is required for decompose command")
      process.exit(1)
    }

    runPreflight()

    // Fetch issue body as task.md
    const taskMdPathD = path.join(taskDir, "task.md")
    if (!fs.existsSync(taskMdPathD)) {
      const issue = getIssue(input.issueNumber)
      if (issue) {
        fs.writeFileSync(taskMdPathD, `# ${issue.title}\n\n${issue.body ?? ""}`)
        logger.info(`  Task loaded from issue #${input.issueNumber}: ${issue.title}`)
      }
    }

    const config = getProjectConfig()
    if (config.timeouts) {
      const { applyTimeoutOverrides } = await import("./definitions.js")
      applyTimeoutOverrides(config.timeouts)
    }
    const litellmProcess = await ensureLitellmProxy(config, projectDir)
    await runModelHealthCheck(config)

    const runners = createRunners(config)
    const defaultRunnerName = config.agent.defaultRunner ?? Object.keys(runners)[0] ?? "claude"
    const defaultRunner = runners[defaultRunnerName]
    if (!defaultRunner) { console.error(`Default runner "${defaultRunnerName}" not configured`); process.exit(1) }
    const healthy = await defaultRunner.healthCheck()
    if (!healthy) { console.error(`Runner "${defaultRunnerName}" health check failed`); process.exit(1) }

    const { runDecompose } = await import("./commands/decompose.js")
    const result = await runDecompose({
      issueNumber: input.issueNumber,
      projectDir,
      runners,
      taskId,
      taskDir,
      local: input.local,
      autoCompose: !input.noCompose,
    })

    if (litellmProcess) litellmProcess.kill()

    if (result.state === "failed") {
      console.error("Decompose failed")
      process.exit(1)
    }

    console.log(`Decompose completed: ${result.subPipelines.length} sub-task(s)`)
    process.exit(0)
  }

  // Compose command — retry merge + verify + review + ship
  if (input.command === "compose") {
    if (!taskId) {
      console.error("--task-id is required for compose command")
      process.exit(1)
    }

    runPreflight()

    const config = getProjectConfig()
    if (config.timeouts) {
      const { applyTimeoutOverrides } = await import("./definitions.js")
      applyTimeoutOverrides(config.timeouts)
    }
    const litellmProcess = await ensureLitellmProxy(config, projectDir)
    await runModelHealthCheck(config)

    const runners = createRunners(config)
    const defaultRunnerName = config.agent.defaultRunner ?? Object.keys(runners)[0] ?? "claude"
    const defaultRunner = runners[defaultRunnerName]
    if (!defaultRunner) { console.error(`Default runner "${defaultRunnerName}" not configured`); process.exit(1) }
    const healthy = await defaultRunner.healthCheck()
    if (!healthy) { console.error(`Runner "${defaultRunnerName}" health check failed`); process.exit(1) }

    const { runCompose } = await import("./commands/compose.js")
    const result = await runCompose({
      projectDir,
      runners,
      taskId,
      taskDir,
      issueNumber: input.issueNumber,
      local: input.local,
    })

    if (litellmProcess) litellmProcess.kill()

    if (result.state === "failed") {
      console.error("Compose failed")
      process.exit(1)
    }

    console.log("Compose completed successfully")
    process.exit(0)
  }

  // Post "pipeline started" comment as early as possible (before heavy init)
  // Skip when taskId was auto-resolved (rerun/approve path) — the pipeline was already
  // started; posting another comment races with the cancellation cascade from the
  // concurrency group and can result in the new run picking up the prior run's URL as taskId.
  if (input.issueNumber && !input.local && !wasAutoResolved) {
    const runUrl = process.env['RUN-URL'] ?? ""
    const runLink = runUrl ? ` ([logs](${runUrl}))` : ""
    try {
      postComment(
        input.issueNumber,
        `🚀 Kody pipeline started: \`${taskId}\`${runLink}`,
      )
    } catch { /* best effort */ }
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
      let taskContent = `# ${issue.title}\n\n${issue.body ?? ""}`

      // Include issue comments — they contain clarifications, decisions, and edge cases
      if (issue.comments.length > 0) {
        taskContent += `\n\n---\n\n## Discussion (${issue.comments.length} comments)\n\n`
        const comments = issue.comments.length > 20
          ? [...issue.comments.slice(0, 5), ...issue.comments.slice(-10)]
          : issue.comments
        if (issue.comments.length > 20) {
          taskContent += `*Showing first 5 and last 10 of ${issue.comments.length} comments*\n\n`
        }
        for (const c of comments) {
          const date = c.createdAt.split("T")[0]
          taskContent += `**@${c.author}** (${date}):\n${c.body}\n\n`
        }
      }

      fs.writeFileSync(taskMdPath, taskContent)
      logger.info(`  Task loaded from issue #${input.issueNumber}: ${issue.title} (${issue.comments.length} comments)`)
    }
  }

  // Verify task.md exists
  if (!fs.existsSync(taskMdPath)) {
    console.error("No task.md found. Provide --task, --issue-number, or ensure .kody/tasks/<id>/task.md exists.")
    process.exit(1)
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

  // Fix command defaults (must run AFTER feedback auto-injection above):
  // with non-empty feedback, re-plan first so the updated scope reaches build.
  // With no feedback, keep the review-only fast path.
  if ((input.command === "fix" || input.command === "fix-ci") && !input.fromStage) {
    input.fromStage = input.feedback?.trim() ? "plan" : "build"
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

  // Detect tools from .kody/tools.yml
  const toolDeclarations = loadToolDeclarations(projectDir)
  const detectedTools = detectTools(toolDeclarations, projectDir)
  if (detectedTools.length > 0) {
    logger.info(`Tools detected: ${detectedTools.map((t) => t.name).join(", ")}`)
  }

  // Hotfix mode: fast-track pipeline (build → verify → ship, no tests)
  const isHotfix = input.command === "hotfix"

  // Resolve parentRunId for fix/rerun commands (cross-run context)
  let parentRunId: string | undefined
  let linkedIssue: number | undefined
  const isRerunLike = input.command === "rerun" || input.command === "fix" || input.command === "fix-ci"
  if (isRerunLike && input.issueNumber) {
    parentRunId = findParentRunId(projectDir, input.issueNumber)
  }

  // PR-to-issue linking for PR-based fix
  if (isPRFix && input.prNumber) {
    linkedIssue = resolveIssueFromPR(input.prNumber)
    if (linkedIssue && !parentRunId) {
      parentRunId = findParentRunId(projectDir, linkedIssue)
    }
  }

  // Build context
  const ctx: PipelineContext = {
    taskId,
    taskDir,
    projectDir,
    runners,
    tools: detectedTools.length > 0 ? detectedTools : undefined,
    input: {
      mode: (input.command === "rerun" || input.command === "fix" || input.command === "fix-ci") ? "rerun" : "full",
      command: input.command,
      fromStage: input.fromStage,
      dryRun: input.dryRun,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      prBaseBranch,
      feedback: input.feedback,
      local: input.local,
      complexity: isHotfix ? "hotfix" : input.complexity,
      skipTests: isHotfix,
      parentRunId,
      linkedIssue,
      autoMode: input.autoMode,
    },
  }

  if (ctx.input.autoMode && process.env.KODY_AUTO_MODE_SUPPORTED !== "true") {
    logger.warn(`  [auto-mode] KODY_AUTO_MODE_SUPPORTED is not set — proceeding anyway`)
  }

  logger.info(`Task: ${taskId}`)
  logger.info(`Mode: ${ctx.input.mode}${ctx.input.local ? " (local)" : " (CI)"}`)
  if (ctx.input.issueNumber) logger.info(`Issue: #${ctx.input.issueNumber}`)

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
  handleFatalError(`❌ Pipeline crashed: ${msg.slice(0, 200)}`, msg)
  process.exit(1)
})
