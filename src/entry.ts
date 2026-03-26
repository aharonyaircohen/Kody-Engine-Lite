import * as fs from "fs"
import * as path from "path"
import { createRunners } from "./agent-runner.js"
import { ensureTaskDir } from "./kody-utils.js"
import { runPipeline, printStatus } from "./state-machine.js"
import { runPreflight } from "./preflight.js"
import { setConfigDir, getProjectConfig } from "./config.js"
import { setGhCwd, getIssue, postComment } from "./github-api.js"
import { logger } from "./logger.js"
import type { PipelineContext } from "./types.js"

const isCI = !!process.env.GITHUB_ACTIONS

interface CliInput {
  command: "run" | "rerun" | "status"
  taskId?: string
  task?: string
  fromStage?: string
  dryRun?: boolean
  cwd?: string
  issueNumber?: number
  feedback?: string
  local?: boolean
  complexity?: "low" | "medium" | "high"
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1]
  }
  return undefined
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function parseArgs(): CliInput {
  const args = process.argv.slice(2)

  if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
    console.log(`Usage:
  kody run    --task-id <id> [--task "<desc>"] [--cwd <path>] [--issue-number <n>] [--complexity low|medium|high] [--feedback "<text>"] [--local] [--dry-run]
  kody rerun  --task-id <id> --from <stage> [--cwd <path>] [--issue-number <n>]
  kody status --task-id <id> [--cwd <path>]
  kody --help`)
    process.exit(0)
  }

  const command = args[0] as "run" | "rerun" | "status"
  if (!["run", "rerun", "status"].includes(command)) {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }

  const issueStr = getArg(args, "--issue-number") ?? process.env.ISSUE_NUMBER
  const localFlag = hasFlag(args, "--local")

  return {
    command,
    taskId: getArg(args, "--task-id") ?? process.env.TASK_ID,
    task: getArg(args, "--task"),
    fromStage: getArg(args, "--from") ?? process.env.FROM_STAGE,
    dryRun: hasFlag(args, "--dry-run") || process.env.DRY_RUN === "true",
    cwd: getArg(args, "--cwd"),
    issueNumber: issueStr ? parseInt(issueStr, 10) : undefined,
    feedback: getArg(args, "--feedback") ?? process.env.FEEDBACK,
    local: localFlag || (!isCI && !hasFlag(args, "--no-local")),
    complexity: (getArg(args, "--complexity") ?? process.env.COMPLEXITY) as "low" | "medium" | "high" | undefined,
  }
}

function findLatestTaskForIssue(issueNumber: number, projectDir: string): string | null {
  const tasksDir = path.join(projectDir, ".tasks")
  if (!fs.existsSync(tasksDir)) return null

  const prefix = `${issueNumber}-`
  const dirs = fs.readdirSync(tasksDir)
    .filter((d) => d.startsWith(prefix))
    .sort()
    .reverse()

  return dirs[0] ?? null
}

function generateTaskId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
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

  // Resolve taskId
  let taskId = input.taskId
  if (!taskId) {
    if (input.command === "rerun" && input.issueNumber) {
      const found = findLatestTaskForIssue(input.issueNumber, projectDir)
      if (!found) {
        console.error(`No previous task found for issue #${input.issueNumber}`)
        process.exit(1)
      }
      taskId = found
      logger.info(`Found latest task for issue #${input.issueNumber}: ${taskId}`)
    } else if (input.issueNumber) {
      taskId = `${input.issueNumber}-${generateTaskId()}`
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

  // Verify task.md exists for run
  if (input.command === "run") {
    if (!fs.existsSync(taskMdPath)) {
      console.error("No task.md found. Provide --task, --issue-number, or ensure .tasks/<id>/task.md exists.")
      process.exit(1)
    }
  }

  // Auto-detect --from for rerun if not provided (find paused stage)
  if (input.command === "rerun" && !input.fromStage) {
    const statusPath = path.join(taskDir, "status.json")
    if (fs.existsSync(statusPath)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"))
        // Find the stage that was paused (completed with "paused" error) or first failed/pending after completed
        const stageNames = ["taskify", "plan", "build", "verify", "review", "review-fix", "ship"]
        let foundPaused = false
        for (const name of stageNames) {
          const s = status.stages[name]
          if (s?.error?.includes("paused")) {
            // Resume from the NEXT stage after the paused one
            const idx = stageNames.indexOf(name)
            if (idx < stageNames.length - 1) {
              input.fromStage = stageNames[idx + 1]
              foundPaused = true
              logger.info(`Auto-detected resume from: ${input.fromStage} (after paused ${name})`)
              break
            }
          }
          if (s?.state === "failed" || s?.state === "pending") {
            input.fromStage = name
            foundPaused = true
            logger.info(`Auto-detected resume from: ${input.fromStage}`)
            break
          }
        }
        if (!foundPaused) {
          input.fromStage = "taskify"
          logger.info("No paused/failed stage found, resuming from taskify")
        }
      } catch {
        console.error("--from <stage> is required (could not read status.json)")
        process.exit(1)
      }
    } else {
      console.error("--from <stage> is required for rerun (no status.json found)")
      process.exit(1)
    }
  }

  // Create runners
  const config = getProjectConfig()
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
      mode: input.command === "rerun" ? "rerun" : "full",
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
    // Post failure comment on issue
    if (ctx.input.issueNumber && !ctx.input.local) {
      const failedStage = Object.entries(state.stages).find(
        ([, s]) => s.state === "failed" || s.state === "timeout",
      )
      const stageName = failedStage ? failedStage[0] : "unknown"
      const error = failedStage ? (failedStage[1] as { error?: string }).error ?? "" : ""
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
