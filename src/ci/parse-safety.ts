/**
 * Validates that a comment trigger is safe to execute.
 * Run by the parse job in GitHub Actions.
 * Reads from env, writes to $GITHUB_OUTPUT.
 */

import * as fs from "fs"

const ALLOWED_ASSOCIATIONS = ["COLLABORATOR", "MEMBER", "OWNER"]

const association = process.env.COMMENT_AUTHOR_ASSOCIATION ?? ""
const outputFile = process.env.GITHUB_OUTPUT

function output(key: string, value: string): void {
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`)
  }
  console.log(`${key}=${value}`)
}

if (!ALLOWED_ASSOCIATIONS.includes(association)) {
  output("valid", "false")
  output("reason", `Author association '${association}' not in allowlist: ${ALLOWED_ASSOCIATIONS.join(", ")}`)
  process.exit(0)
}

output("valid", "true")
output("reason", "")
