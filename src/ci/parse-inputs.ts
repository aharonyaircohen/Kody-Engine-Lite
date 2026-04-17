/**
 * Parses @kody / /kody comment body into structured inputs.
 * Run by the parse job in GitHub Actions.
 * Reads from env, writes to $GITHUB_OUTPUT.
 *
 * Supports all modes: full, rerun, fix, fix-ci, status, approve, review, resolve, bootstrap, taskify, hotfix, revert
 * Supports flags: --from, --feedback (quoted), --complexity, --dry-run, --ci-run-id, --ticket, --file
 */

import * as fs from "fs"

export interface ParseResult {
  task_id: string
  mode: string
  from_stage: string
  issue_number: string
  pr_number: string
  feedback: string
  complexity: string
  ci_run_id: string
  ticket_id: string
  prd_file: string
  /** "provider/model" string. */
  model: string
  bump: string
  finalize: boolean
  no_publish: boolean
  no_notify: boolean
  revert_target: string
  dry_run: boolean
  valid: boolean
  trigger_type: string
}

const VALID_MODES = [
  "full", "rerun", "fix", "fix-ci", "status",
  "approve", "review", "resolve", "bootstrap", "taskify", "ask", "release",
  "hotfix", "revert",
] as const

function generateTimestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const y = String(now.getFullYear()).slice(2)
  const m = pad(now.getMonth() + 1)
  const d = pad(now.getDate())
  const H = pad(now.getHours())
  const M = pad(now.getMinutes())
  const S = pad(now.getSeconds())
  return `${y}${m}${d}-${H}${M}${S}`
}

const ALLOWED_ASSOCIATIONS = ["COLLABORATOR", "MEMBER", "OWNER"]

function isAuthorAllowed(): boolean {
  const assoc = process.env.COMMENT_AUTHOR_ASSOC ?? ""
  return ALLOWED_ASSOCIATIONS.includes(assoc)
}

/**
 * Pure parsing logic — reads from process.env, returns structured result.
 * Does NOT write to GITHUB_OUTPUT (caller handles that).
 */
export function parseCommentInputs(): ParseResult {
  const triggerType = process.env.TRIGGER_TYPE ?? "dispatch"

  // ─── Dispatch passthrough ───────────────────────────────────────────────
  if (triggerType === "dispatch") {
    const taskId = process.env.INPUT_TASK_ID ?? ""
    return {
      task_id: taskId,
      mode: process.env.INPUT_MODE ?? "full",
      from_stage: process.env.INPUT_FROM_STAGE ?? "",
      issue_number: process.env.INPUT_ISSUE_NUMBER ?? "",
      pr_number: "",
      feedback: process.env.INPUT_FEEDBACK ?? "",
      complexity: "",
      ci_run_id: "",
      ticket_id: "",
      prd_file: "",
      model: process.env.INPUT_MODEL ?? "",
      bump: "",
      finalize: false,
      no_publish: false,
      no_notify: false,
      revert_target: "",
      dry_run: false,
      valid: !!taskId,
      trigger_type: "dispatch",
    }
  }

  // ─── Comment parsing ──────────────────────────────────────────────────
  if (!isAuthorAllowed()) {
    return {
      task_id: "", mode: "full", from_stage: "", issue_number: process.env.ISSUE_NUMBER ?? "",
      pr_number: "", feedback: "", complexity: "", ci_run_id: "", ticket_id: "", prd_file: "",
      model: "",
      bump: "", finalize: false, no_publish: false, no_notify: false, revert_target: "",
      dry_run: false, valid: false, trigger_type: "comment",
    }
  }

  const commentBody = (process.env.COMMENT_BODY ?? "").replace(/\r/g, "")
  const issueNumber = process.env.ISSUE_NUMBER ?? ""
  const isPR = !!(process.env.ISSUE_IS_PR)

  // Match @kody or /kody at the start of a line (case-insensitive)
  const kodyMatch = commentBody.match(/(?:@kody|\/kody)\s*(.*)/i)
  if (!kodyMatch) {
    return {
      task_id: "", mode: "full", from_stage: "", issue_number: issueNumber,
      pr_number: "", feedback: "", complexity: "", ci_run_id: "", ticket_id: "", prd_file: "",
      model: "",
      bump: "", finalize: false, no_publish: false, no_notify: false, revert_target: "",
      dry_run: false, valid: false, trigger_type: "comment",
    }
  }

  // The first line args after @kody
  const argsLine = kodyMatch[1].trim()

  // ─── Extract flags from the first line ────────────────────────────────
  let fromStage = ""
  let feedback = ""
  let complexity = ""
  let dryRun = false
  let ciRunId = ""
  let ticketId = ""
  let prdFile = ""
  let model = ""
  let bump = ""
  let finalize = false
  let noPublish = false
  let noNotify = false

  // Extract --from (supports --from value and --from=value)
  const fromMatch = argsLine.match(/--from[=\s]+(\S+)/)
  if (fromMatch) fromStage = fromMatch[1]

  // Extract --feedback "quoted text" (supports --feedback="text" and --feedback "text")
  const feedbackMatch = argsLine.match(/--feedback[=\s]+"([^"]*)"/)
  if (feedbackMatch) feedback = feedbackMatch[1]

  // Extract --complexity
  const complexityMatch = argsLine.match(/--complexity[=\s]+(\S+)/)
  if (complexityMatch) complexity = complexityMatch[1]

  // Extract --dry-run
  if (/--dry-run/.test(argsLine)) dryRun = true

  // Extract --ci-run-id
  const ciRunIdMatch = argsLine.match(/--ci-run-id[=\s]+(\S+)/)
  if (ciRunIdMatch) ciRunId = ciRunIdMatch[1]

  // Extract --ticket
  const ticketMatch = argsLine.match(/--ticket[=\s]+(\S+)/)
  if (ticketMatch) ticketId = ticketMatch[1]

  // Extract --file
  const fileMatch = argsLine.match(/--file[=\s]+(\S+)/)
  if (fileMatch) prdFile = fileMatch[1]

  // Extract --model "provider/model"
  const modelMatch = argsLine.match(/--model[=\s]+(\S+)/)
  if (modelMatch) model = modelMatch[1]

  // Extract --bump (for release mode)
  const bumpMatch = argsLine.match(/--bump[=\s]+(\S+)/)
  if (bumpMatch) bump = bumpMatch[1]

  // Extract --finalize (for release mode)
  if (/--finalize/.test(argsLine)) finalize = true

  // Extract --no-publish (for release mode)
  if (/--no-publish/.test(argsLine)) noPublish = true

  // Extract --no-notify (for release mode)
  if (/--no-notify/.test(argsLine)) noNotify = true

  // ─── Strip flags to get positional args ───────────────────────────────
  const positional = argsLine
    .replace(/--from[=\s]+\S+/g, "")
    .replace(/--feedback[=\s]+"[^"]*"/g, "")
    .replace(/--complexity[=\s]+\S+/g, "")
    .replace(/--dry-run/g, "")
    .replace(/--ci-run-id[=\s]+\S+/g, "")
    .replace(/--ticket[=\s]+\S+/g, "")
    .replace(/--file[=\s]+\S+/g, "")
    .replace(/--model[=\s]+\S+/g, "")
    .replace(/--bump[=\s]+\S+/g, "")
    .replace(/--finalize/g, "")
    .replace(/--no-publish/g, "")
    .replace(/--no-notify/g, "")
    .replace(/\s+/g, " ")
    .trim()

  const parts = positional ? positional.split(/\s+/) : []

  // ─── Determine mode and task-id ───────────────────────────────────────
  let mode = "full"
  let taskId = ""
  let idx = 0

  if (parts[idx] && (VALID_MODES as readonly string[]).includes(parts[idx])) {
    mode = parts[idx]
    idx++
  }

  // Next positional is task-id (if it doesn't start with --)
  if (parts[idx] && !parts[idx].startsWith("--")) {
    taskId = parts[idx]
    idx++
  } else if (parts[0] && !(VALID_MODES as readonly string[]).includes(parts[0]) && !parts[0].startsWith("--")) {
    // Unknown first word that wasn't a mode — treat as task-id
    taskId = parts[0]
  }

  // ─── Extract body (lines after the @kody line) ───────────────────────
  const kodyLineIdx = commentBody.search(/(?:@kody|\/kody)/i)
  const afterKodyLine = commentBody.slice(kodyLineIdx)
  const newlineIdx = afterKodyLine.indexOf("\n")
  const bodyAfterCommand = newlineIdx !== -1 ? afterKodyLine.slice(newlineIdx + 1) : ""

  // ─── Mode-specific transformations ────────────────────────────────────

  // approve → rerun with body as feedback
  // Any text after "approve" on the same line is inline feedback (e.g. "@kody approve acceptable"),
  // NOT a task-id. Task-id for rerun is resolved by the engine from the last run for this issue.
  if (mode === "approve") {
    mode = "rerun"
    // Collect all remaining positional words after "approve" as inline feedback
    const approveIdx = parts.indexOf("approve")
    const inlineText = parts.slice(approveIdx + 1).join(" ")
    taskId = ""
    if (inlineText) {
      feedback = inlineText
    }
    if (bodyAfterCommand) {
      feedback = feedback ? feedback + "\n" + bodyAfterCommand : bodyAfterCommand
    }
  }

  // fix: extract body as feedback
  if (mode === "fix") {
    if (bodyAfterCommand) {
      feedback = bodyAfterCommand
    }
  }

  // fix-ci: extract body as feedback + ci-run-id from body
  if (mode === "fix-ci") {
    if (bodyAfterCommand) {
      feedback = bodyAfterCommand
      const runIdFromBody = bodyAfterCommand.match(/Run ID:\s*(\d+)/)
      if (runIdFromBody) {
        ciRunId = runIdFromBody[1]
      }
    }
  }

  // bootstrap: auto-generate task-id
  if (mode === "bootstrap") {
    taskId = `bootstrap-${generateTimestamp()}`
  }

  // ask: extract body as the question, auto-generate task-id
  if (mode === "ask") {
    taskId = `ask-${issueNumber}-${generateTimestamp()}`
    if (bodyAfterCommand) {
      feedback = bodyAfterCommand
    }
  }

  // taskify: auto-generate task-id
  if (mode === "taskify") {
    taskId = `taskify-${issueNumber}-${generateTimestamp()}`
  }

  // release: auto-generate task-id
  if (mode === "release") {
    taskId = `release-${generateTimestamp()}`
  }

  // hotfix: auto-generate task-id
  if (mode === "hotfix") {
    taskId = `hotfix-${issueNumber}-${generateTimestamp()}`
  }

  // revert: auto-generate task-id, capture revert target from positional
  let revertTarget = ""
  if (mode === "revert") {
    // The parser captured the positional after "revert" as taskId (e.g. "#87" or "87")
    // Reclaim it as the revert target
    if (taskId && /^#?\d+$/.test(taskId)) {
      revertTarget = taskId.replace(/^#/, "")
      taskId = ""
    }
    taskId = `revert-${generateTimestamp()}`
  }

  // PR detection
  const prNumber = isPR ? issueNumber : ""

  // Review on PR: generate review-pr task-id
  if (mode === "review" && prNumber) {
    taskId = `review-pr-${prNumber}-${generateTimestamp()}`
  }

  // Decompose: the word "decompose" is not a VALID_MODE, so it lands as taskId.
  // Generate a unique task-id so parallel decompose runs don't collide.
  if (taskId === "decompose") {
    taskId = `decompose-${issueNumber}-${generateTimestamp()}`
  }

  // Auto-generate task-id for full mode when not provided
  if (!taskId && mode === "full") {
    taskId = `${issueNumber}-${generateTimestamp()}`
  }

  // Valid if we have a task-id, or if mode is one that doesn't need one (fix, fix-ci, status, review, resolve)
  const modesWithoutTaskId = ["fix", "fix-ci", "status", "review", "resolve", "rerun", "release", "hotfix", "revert"]
  const valid = !!taskId || modesWithoutTaskId.includes(mode)

  // taskify is valid with just the issue body (inline mode), ticket, or prd file
  // No validation needed — the taskify command itself will use the issue body if no ticket/file

  return {
    task_id: taskId,
    mode,
    from_stage: fromStage,
    issue_number: issueNumber,
    pr_number: prNumber,
    feedback,
    complexity,
    ci_run_id: ciRunId,
    ticket_id: ticketId,
    prd_file: prdFile,
    model,
    bump,
    finalize,
    no_publish: noPublish,
    no_notify: noNotify,
    revert_target: revertTarget,
    dry_run: dryRun,
    valid,
    trigger_type: "comment",
  }
}

// ─── Write to GITHUB_OUTPUT ─────────────────────────────────────────────────

export function writeOutputs(result: ParseResult): void {
  const outputFile = process.env.GITHUB_OUTPUT

  function output(key: string, value: string): void {
    if (outputFile) {
      // Use heredoc delimiter for multiline values (feedback)
      if (value.includes("\n")) {
        fs.appendFileSync(outputFile, `${key}<<KODY_EOF\n${value}\nKODY_EOF\n`)
      } else {
        fs.appendFileSync(outputFile, `${key}=${value}\n`)
      }
    }
    // Log single-line summary
    const display = value.includes("\n") ? value.split("\n")[0] + "..." : value
    console.log(`${key}=${display}`)
  }

  output("task_id", result.task_id)
  output("mode", result.mode)
  output("from_stage", result.from_stage)
  output("issue_number", result.issue_number)
  output("pr_number", result.pr_number)
  output("feedback", result.feedback)
  output("complexity", result.complexity)
  output("ci_run_id", result.ci_run_id)
  output("ticket_id", result.ticket_id)
  output("prd_file", result.prd_file)
  output("model", result.model)
  output("bump", result.bump)
  output("finalize", result.finalize ? "true" : "false")
  output("no_publish", result.no_publish ? "true" : "false")
  output("no_notify", result.no_notify ? "true" : "false")
  output("revert_target", result.revert_target)
  output("dry_run", result.dry_run ? "true" : "false")
  output("valid", result.valid ? "true" : "false")
  output("trigger_type", result.trigger_type)
}

// ─── CLI entry point (when run directly or via ci-parse command) ────────────

export function runCiParse(): void {
  const result = parseCommentInputs()
  writeOutputs(result)
}
