import * as fs from "fs"
import * as path from "path"
import { createClaudeCodeRunner } from "./agent-runner.js"
import { ensureTaskDir } from "./kody-utils.js"
import { runPipeline, printStatus } from "./state-machine.js"
import { runPreflight } from "./preflight.js"
import { setConfigDir } from "./config.js"
import { logger } from "./logger.js"
import type { PipelineContext } from "./types.js"

interface CliInput {
  command: "run" | "rerun" | "status"
  taskId?: string
  task?: string
  fromStage?: string
  dryRun?: boolean
  cwd?: string
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
  kody run    --task-id <id> [--task "<description>"] [--cwd <path>] [--dry-run]
  kody rerun  --task-id <id> --from <stage> [--cwd <path>]
  kody status --task-id <id> [--cwd <path>]
  kody --help`)
    process.exit(0)
  }

  const command = args[0] as "run" | "rerun" | "status"
  if (!["run", "rerun", "status"].includes(command)) {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }

  return {
    command,
    taskId: getArg(args, "--task-id") ?? process.env.TASK_ID,
    task: getArg(args, "--task"),
    fromStage: getArg(args, "--from") ?? process.env.FROM_STAGE,
    dryRun: hasFlag(args, "--dry-run") || process.env.DRY_RUN === "true",
    cwd: getArg(args, "--cwd"),
  }
}

function generateTaskId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function main() {
  const input = parseArgs()

  // Resolve taskId
  let taskId = input.taskId
  if (!taskId) {
    if (input.command === "run" && input.task) {
      taskId = generateTaskId()
    } else {
      console.error("--task-id is required")
      process.exit(1)
    }
  }

  // Resolve working directory
  const projectDir = input.cwd ? path.resolve(input.cwd) : process.cwd()
  if (input.cwd) {
    if (!fs.existsSync(projectDir)) {
      console.error(`--cwd path does not exist: ${projectDir}`)
      process.exit(1)
    }
    setConfigDir(projectDir)
    logger.info(`Working directory: ${projectDir}`)
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

  // Verify task.md exists for run
  if (input.command === "run") {
    const taskMdPath = path.join(taskDir, "task.md")
    if (!fs.existsSync(taskMdPath)) {
      console.error("No task.md found. Provide --task or ensure .tasks/<id>/task.md exists.")
      process.exit(1)
    }
  }

  // Validate rerun has --from
  if (input.command === "rerun" && !input.fromStage) {
    console.error("--from <stage> is required for rerun")
    process.exit(1)
  }

  // Create runner
  const runner = createClaudeCodeRunner()
  const healthy = await runner.healthCheck()
  if (!healthy) {
    console.error("Claude Code CLI not available. Install: npm i -g @anthropic-ai/claude-code")
    process.exit(1)
  }

  // Build context
  const ctx: PipelineContext = {
    taskId,
    taskDir,
    projectDir,
    runner,
    input: {
      mode: input.command === "rerun" ? "rerun" : "full",
      fromStage: input.fromStage,
      dryRun: input.dryRun,
    },
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
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
