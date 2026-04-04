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

// ─── arg helpers ─────────────────────────────────────────────────────────────

export function getArg(args: string[], flag: string): string | undefined {
  for (const a of args) {
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  const idx = args.indexOf(flag)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1]
  }
  return undefined
}

// ─── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]

if (command === "init") {
  initCommand({ force: args.includes("--force") }, PKG_ROOT)
} else if (command === "bootstrap") {
  bootstrapCommand({
    force: args.includes("--force"),
    provider: getArg(args, "--provider"),
    model: getArg(args, "--model"),
  }, PKG_ROOT).catch((err) => {
    console.error(`Bootstrap failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
} else if (command === "taskify") {
  import("../cli/taskify-command.js").then(({ runTaskifyCommand }) => runTaskifyCommand())
} else if (command === "test-model") {
  import("../cli/test-model-command.js").then(({ runTestModelCommand }) => runTestModelCommand())
} else if (command === "ci-parse") {
  import("../ci/parse-inputs.js").then(({ runCiParse }) => runCiParse())
} else if (command === "watch") {
  import("../watch/index.js").then(({ runWatchCommand }) =>
    runWatchCommand({ dryRun: args.includes("--dry-run") }),
  )
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(getVersion())
} else {
  // Default: run the pipeline (import the entry module)
  import("../entry.js")
}
