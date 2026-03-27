export interface CliInput {
  command: "run" | "rerun" | "fix" | "status"
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

const isCI = !!process.env.GITHUB_ACTIONS

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

export function parseArgs(): CliInput {
  const args = process.argv.slice(2)

  if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
    console.log(`Usage:
  kody run    --task-id <id> [--task "<desc>"] [--cwd <path>] [--issue-number <n>] [--complexity low|medium|high] [--feedback "<text>"] [--local] [--dry-run]
  kody rerun  --task-id <id> --from <stage> [--cwd <path>] [--issue-number <n>]
  kody fix    --task-id <id> [--cwd <path>] [--issue-number <n>] [--feedback "<text>"]
  kody status --task-id <id> [--cwd <path>]
  kody --help`)
    process.exit(0)
  }

  const command = args[0] as "run" | "rerun" | "fix" | "status"
  if (!["run", "rerun", "fix", "status"].includes(command)) {
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
