/**
 * Parses @kody / /kody comment body into structured inputs.
 * Run by the parse job in GitHub Actions.
 * Reads from env, writes to $GITHUB_OUTPUT.
 */

import * as fs from "fs"

const outputFile = process.env.GITHUB_OUTPUT
const triggerType = process.env.TRIGGER_TYPE ?? "dispatch"

function output(key: string, value: string): void {
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`)
  }
  console.log(`${key}=${value}`)
}

// For workflow_dispatch, pass through inputs
if (triggerType === "dispatch") {
  output("task_id", process.env.INPUT_TASK_ID ?? "")
  output("mode", process.env.INPUT_MODE ?? "full")
  output("from_stage", process.env.INPUT_FROM_STAGE ?? "")
  output("issue_number", process.env.INPUT_ISSUE_NUMBER ?? "")
  output("feedback", process.env.INPUT_FEEDBACK ?? "")
  output("valid", process.env.INPUT_TASK_ID ? "true" : "false")
  output("trigger_type", "dispatch")
  process.exit(0)
}

// For issue_comment, parse the comment body
const commentBody = process.env.COMMENT_BODY ?? ""
const issueNumber = process.env.ISSUE_NUMBER ?? ""

// Match: @kody [mode] [task-id] [--from stage] [--feedback "text"]
const kodyMatch = commentBody.match(/(?:@kody|\/kody)\s*(.*)/i)
if (!kodyMatch) {
  output("valid", "false")
  output("trigger_type", "comment")
  process.exit(0)
}

const parts = kodyMatch[1].trim().split(/\s+/)
const validModes = ["full", "rerun", "status"]

let mode = "full"
let taskId = ""
let fromStage = ""
let feedback = ""

let i = 0

// First arg: mode or task-id
if (parts[i] && validModes.includes(parts[i])) {
  mode = parts[i]
  i++
}

// Second arg: task-id
if (parts[i] && !parts[i].startsWith("--")) {
  taskId = parts[i]
  i++
}

// Named args
while (i < parts.length) {
  if (parts[i] === "--from" && parts[i + 1]) {
    fromStage = parts[i + 1]
    i += 2
  } else if (parts[i] === "--feedback" && parts[i + 1]) {
    // Collect quoted feedback
    const rest = parts.slice(i + 1).join(" ")
    const quoted = rest.match(/^"([^"]*)"/)
    feedback = quoted ? quoted[1] : parts[i + 1]
    break
  } else {
    i++
  }
}

output("task_id", taskId)
output("mode", mode)
output("from_stage", fromStage)
output("issue_number", issueNumber)
output("feedback", feedback)
output("valid", taskId ? "true" : "false")
output("trigger_type", "comment")
