/**
 * CLI entry point for @kody-ade/kody-engine-lite
 *
 * Commands:
 *   init      — Setup target repo: workflow, config, labels, bootstrap issue
 *   bootstrap — Generate project memory + step files (runs in GH Actions)
 *   run       — Run the Kody pipeline (default when no command given)
 *   version   — Print package version
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { initCommand } from "./commands/init.js"
import { bootstrapCommand } from "./commands/bootstrap.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..", "..")

function getVersion(): string {
  const pkgPath = path.join(PKG_ROOT, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
  return pkg.version
}

// ─── Re-exports for test compatibility ──────────────────────────────────────

export { checkCommand, checkFile, checkGhAuth, checkGhRepoAccess, checkGhSecret } from "./health-checks.js"
export type { CheckResult } from "./health-checks.js"
export { detectBasicConfig, buildConfig } from "./config-detection.js"
export { detectArchitectureBasic } from "./architecture-detection.js"
export { detectSkillsForProject } from "./skills.js"

// ─── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]

if (command === "init") {
  initCommand({ force: args.includes("--force") }, PKG_ROOT)
} else if (command === "bootstrap") {
  bootstrapCommand({ force: args.includes("--force") }, PKG_ROOT)
} else if (command === "taskify") {
  import("../cli/taskify-command.js").then(({ runTaskifyCommand }) => runTaskifyCommand())
} else if (command === "ci-parse") {
  import("../ci/parse-inputs.js").then(({ runCiParse }) => runCiParse())
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(getVersion())
} else {
  // Default: run the pipeline (import the entry module)
  import("../entry.js")
}
