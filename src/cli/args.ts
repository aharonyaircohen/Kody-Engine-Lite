export interface CliInput {
  command: "run" | "rerun" | "fix" | "fix-ci" | "status" | "review" | "resolve" | "decompose" | "compose" | "ask"
  taskId?: string
  task?: string
  fromStage?: string
  dryRun?: boolean
  cwd?: string
  issueNumber?: number
  prNumber?: number
  feedback?: string
  local?: boolean
  complexity?: "low" | "medium" | "high"
  ciRunId?: string
  noCompose?: boolean
  provider?: string
  model?: string
}

const isCI = !!process.env.GITHUB_ACTIONS

function getArg(args: string[], flag: string): string | undefined {
  for (const a of args) {
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
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

  // --ask "question" shorthand — no subcommand needed
  const askQuestion = getArg(args, "--ask")
  if (askQuestion) {
    return {
      command: "ask",
      feedback: askQuestion,
      cwd: getArg(args, "--cwd"),
      issueNumber: (() => {
        const s = getArg(args, "--issue-number") ?? process.env.ISSUE_NUMBER
        return s ? parseInt(s, 10) : undefined
      })(),
      local: hasFlag(args, "--local") || (!isCI && !hasFlag(args, "--no-local")),
    }
  }

  if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
    console.log(`Usage:
  kody --ask "<question>" [--issue-number <n>] [--cwd <path>]
  kody run       --task-id <id> [--task "<desc>"] [--cwd <path>] [--issue-number <n>] [--complexity low|medium|high] [--feedback "<text>"] [--local] [--dry-run]
  kody rerun     --task-id <id> --from <stage> [--cwd <path>] [--issue-number <n>]
  kody fix       --task-id <id> [--cwd <path>] [--issue-number <n>] [--feedback "<text>"]
  kody fix-ci    [--pr-number <n>] [--ci-run-id <id>] [--cwd <path>] [--issue-number <n>] [--feedback "<text>"]
  kody review    [--pr-number <n>] [--issue-number <n>] [--cwd <path>] [--local]
  kody resolve   --pr-number <n> [--cwd <path>] [--local]
  kody decompose --issue-number <n> [--cwd <path>] [--local] [--no-compose]
  kody compose   --task-id <id> [--issue-number <n>] [--cwd <path>] [--local]
  kody status    --task-id <id> [--cwd <path>]
  kody --help`)
    process.exit(0)
  }

  const command = args[0] as CliInput["command"]
  if (!["run", "rerun", "fix", "fix-ci", "status", "review", "resolve", "decompose", "compose", "ask"].includes(command)) {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }

  const issueStr = getArg(args, "--issue-number") ?? process.env.ISSUE_NUMBER
  const prStr = getArg(args, "--pr-number") ?? process.env.PR_NUMBER
  const localFlag = hasFlag(args, "--local")

  return {
    command,
    taskId: getArg(args, "--task-id") ?? process.env.TASK_ID,
    task: getArg(args, "--task"),
    fromStage: getArg(args, "--from") ?? process.env.FROM_STAGE,
    dryRun: hasFlag(args, "--dry-run") || process.env.DRY_RUN === "true",
    cwd: getArg(args, "--cwd"),
    issueNumber: issueStr ? parseInt(issueStr, 10) : undefined,
    prNumber: prStr ? parseInt(prStr, 10) : undefined,
    feedback: getArg(args, "--feedback") ?? process.env.FEEDBACK,
    local: localFlag || (!isCI && !hasFlag(args, "--no-local")),
    complexity: (getArg(args, "--complexity") ?? process.env.COMPLEXITY) as "low" | "medium" | "high" | undefined,
    ciRunId: getArg(args, "--ci-run-id") ?? process.env.CI_RUN_ID,
    noCompose: hasFlag(args, "--no-compose"),
    provider: getArg(args, "--provider") ?? process.env.PROVIDER ?? undefined,
    model: getArg(args, "--model") ?? process.env.MODEL ?? undefined,
  }
}
