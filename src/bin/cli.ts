/**
 * CLI entry point for @kody-ade/kody-engine-lite
 *
 * Commands:
 *   init      — Setup target repo: workflow, config, labels, bootstrap issue
 *   bootstrap — Generate project memory + step files (runs in GH Actions)
 *   run       — Run the Kody pipeline (default when no command given)
 *   hotfix    — Fast-track pipeline: build → verify (no tests) → ship
 *   revert    — Revert a merged PR: git revert → verify → create PR
 *   release   — Automate version bump, changelog, release PR, tagging, publish
 *   serve     — Start LiteLLM + dev server + Claude Code (local hot session)
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
} else if (command === "ci-export-secrets") {
  import("../ci/export-secrets.js").then(({ runExportSecrets }) => runExportSecrets())
} else if (command === "ci-build-args") {
  import("../ci/build-args.js").then(({ runBuildArgs }) => runBuildArgs())
} else if (command === "ci-summarize") {
  import("../ci/summarize.js").then(({ runSummarize }) => runSummarize())
} else if (command === "ci-close-issue") {
  import("../ci/close-issue.js").then(({ runCloseIssue }) => runCloseIssue().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  }))
} else if (command === "fix-ci-trigger") {
  import("../ci/fix-ci-trigger.js").then(({ runFixCiTrigger }) => runFixCiTrigger().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  }))
} else if (command === "serve") {
  import("./commands/serve.js").then(({ serveCommand }) => serveCommand(args.slice(1)))
} else if (command === "chat") {
  import("./commands/chat.js").then(({ chatCommand }) =>
    chatCommand(args.slice(1)).catch((err) => {
      console.error(`Chat failed: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }),
  )
} else if (command === "brain") {
  import("./commands/brain.js").then(({ runBrainCommand }) => runBrainCommand(args.slice(1)))
} else if (command === "graph") {
  import("./commands/graph.js").then(({ runGraphCommand }) => runGraphCommand(args.slice(1))).catch((err) => {
    console.error(`Graph command failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
} else if (command === "watch") {
  import("../watch/index.js").then(({ runWatchCommand }) =>
    runWatchCommand({
      dryRun: args.includes("--dry-run"),
      agent: getArg(args, "--agent"),
    }),
  )
} else if (command === "release") {
  import("./commands/release.js").then(({ releaseCommand, releaseFinalizeCommand }) => {
    const issueStr = getArg(args, "--issue-number") ?? process.env.ISSUE_NUMBER
    const input = {
      bump: getArg(args, "--bump") as "major" | "minor" | "patch" | undefined,
      dryRun: args.includes("--dry-run"),
      finalize: args.includes("--finalize"),
      noPublish: args.includes("--no-publish"),
      noNotify: args.includes("--no-notify"),
      issueNumber: issueStr ? parseInt(issueStr, 10) : undefined,
      version: getArg(args, "--version") ?? undefined,
      merge: args.includes("--merge"),
      cwd: getArg(args, "--cwd"),
    }
    return input.finalize ? releaseFinalizeCommand(input) : releaseCommand(input)
  }).catch((err) => {
    console.error(`Release failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
} else if (command === "revert") {
  import("./commands/revert.js").then(({ revertCommand }) => {
    const issueStr = getArg(args, "--issue-number") ?? process.env.ISSUE_NUMBER
    return revertCommand({
      target: getArg(args, "--target") ?? args[1]?.replace(/^#/, ""),
      issueNumber: issueStr ? parseInt(issueStr, 10) : undefined,
      dryRun: args.includes("--dry-run"),
      cwd: getArg(args, "--cwd"),
    })
  }).catch((err) => {
    console.error(`Revert failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(getVersion())
} else if (command === "chat") {
  import("./commands/chat.js").then(({ chatCommand }) =>
    chatCommand(args.slice(1)).catch((err) => {
      console.error(`Chat failed: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }),
  )
} else {
  // Default: run the pipeline (import the entry module)
  import("../entry.js")
}
