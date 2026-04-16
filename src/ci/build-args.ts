/**
 * Builds the kody-engine command arguments based on the current CI mode and env vars.
 *
 * Usage: kody-engine ci-build-args
 *
 * Env vars (all optional unless mode requires them):
 *   MODE          — release | revert | bootstrap | taskify | run (default)
 *   TASK_ID       — task identifier
 *   ISSUE_NUMBER  — GitHub issue/PR number
 *   PR_NUMBER     — PR number (for review mode)
 *   FROM_STAGE    — stage to resume from
 *   COMPLEXITY    — complexity hint
 *   FEEDBACK      — inline feedback text
 *   DRY_RUN       — "true" to enable dry-run
 *   AUTO_MODE     — "true" to enable auto-mode
 *   FINALIZE      — "true" (release finalize)
 *   BUMP          — major | minor | patch (release)
 *   NO_PUBLISH    — "true" (release)
 *   NO_NOTIFY     — "true" (release)
 *   REVERT_TARGET — issue/PR to revert (revert mode)
 *   TICKET_ID     — ticket ID (taskify)
 *   PRD_FILE      — PRD file path (taskify)
 *
 * Output: the kody-engine subcommand with args, printed to stdout.
 * Example output: "run --issue-number 42 --task-id abc123"
 */

export interface CiEnv {
  MODE: string
  TASK_ID: string
  ISSUE_NUMBER: string
  PR_NUMBER: string
  FROM_STAGE: string
  COMPLEXITY: string
  FEEDBACK: string
  DRY_RUN: string
  AUTO_MODE: string
  FINALIZE: string
  BUMP: string
  NO_PUBLISH: string
  NO_NOTIFY: string
  REVERT_TARGET: string
  TICKET_ID: string
  PRD_FILE: string
}

function flag(name: string, value: string): string {
  return value ? ` --${name} ${value}` : ""
}

function flagEq(name: string, value: string): string {
  return value ? ` --${name}=${value}` : ""
}

function boolFlag(name: string, value: string): string {
  return value === "true" ? ` --${name}` : ""
}

/**
 * Builds the base args shared by run/fix/rerun/review/resolve/hotfix modes.
 */
function buildRunArgs(env: CiEnv): string {
  let args = ""
  if (env.ISSUE_NUMBER) args += flag("issue-number", env.ISSUE_NUMBER)
  if (env.TASK_ID) args += flag("task-id", env.TASK_ID)
  if (env.PR_NUMBER) args += flag("pr-number", env.PR_NUMBER)
  if (env.FROM_STAGE) args += flag("from", env.FROM_STAGE)
  if (env.COMPLEXITY) args += flag("complexity", env.COMPLEXITY)
  if (env.FEEDBACK) args += flag("feedback", `"${env.FEEDBACK}"`)
  args += boolFlag("dry-run", env.DRY_RUN)
  args += boolFlag("auto-mode", env.AUTO_MODE)
  return args
}

/**
 * Pure function: given CI env vars, returns the kody-engine command string.
 */
export function buildArgs(env: CiEnv): string {
  const mode = env.MODE || "run"

  if (mode === "release") {
    let args = ""
    args += boolFlag("finalize", env.FINALIZE)
    if (env.BUMP) args += flagEq("bump", env.BUMP)
    args += boolFlag("no-publish", env.NO_PUBLISH)
    args += boolFlag("no-notify", env.NO_NOTIFY)
    args += boolFlag("dry-run", env.DRY_RUN)
    if (env.ISSUE_NUMBER) args += flag("issue-number", env.ISSUE_NUMBER)
    return `release${args}`
  }

  if (mode === "revert") {
    let args = ""
    if (env.REVERT_TARGET) args += flag("target", env.REVERT_TARGET)
    if (env.ISSUE_NUMBER) args += flag("issue-number", env.ISSUE_NUMBER)
    args += boolFlag("dry-run", env.DRY_RUN)
    return `revert${args}`
  }

  if (mode === "bootstrap") {
    return "bootstrap"
  }

  if (mode === "taskify") {
    let args = ""
    if (env.TICKET_ID) args += flag("ticket", env.TICKET_ID)
    if (env.PRD_FILE) args += flag("file", env.PRD_FILE)
    if (env.ISSUE_NUMBER) args += flag("issue-number", env.ISSUE_NUMBER)
    if (env.TASK_ID) args += flag("task-id", env.TASK_ID)
    return `taskify${args}`
  }

  // Default: run/fix/rerun/fix-ci/review/resolve/hotfix/status
  const cmdMap: Record<string, string> = {
    rerun: "rerun",
    fix: "fix",
    "fix-ci": "fix-ci",
    review: "review",
    resolve: "resolve",
    hotfix: "hotfix",
    status: "status",
  }
  const subCmd = cmdMap[mode] ?? "run"

  return `${subCmd}${buildRunArgs(env)}`
}

/**
 * Reads env vars and prints the built command to stdout.
 */
export function runBuildArgs(): void {
  const env: CiEnv = {
    MODE: process.env.MODE ?? "",
    TASK_ID: process.env.TASK_ID ?? "",
    ISSUE_NUMBER: process.env.ISSUE_NUMBER ?? "",
    PR_NUMBER: process.env.PR_NUMBER ?? "",
    FROM_STAGE: process.env.FROM_STAGE ?? "",
    COMPLEXITY: process.env.COMPLEXITY ?? "",
    FEEDBACK: process.env.FEEDBACK ?? "",
    DRY_RUN: process.env.DRY_RUN ?? "false",
    AUTO_MODE: process.env.AUTO_MODE ?? "false",
    FINALIZE: process.env.FINALIZE ?? "false",
    BUMP: process.env.BUMP ?? "",
    NO_PUBLISH: process.env.NO_PUBLISH ?? "false",
    NO_NOTIFY: process.env.NO_NOTIFY ?? "false",
    REVERT_TARGET: process.env.REVERT_TARGET ?? "",
    TICKET_ID: process.env.TICKET_ID ?? "",
    PRD_FILE: process.env.PRD_FILE ?? "",
  }

  console.log(buildArgs(env))
}
