import * as fs from "fs"
import * as path from "path"

import type {
  StageDefinition,
  StageResult,
  PipelineContext,
  ResolvedTool,
} from "../types.js"
import { runQualityGates } from "../verify-runner.js"
import { logger } from "../logger.js"
import { getModifiedFiles, errorReferencesAnyOf } from "../observer.js"

export function executeGateStage(
  ctx: PipelineContext,
  def: StageDefinition,
): StageResult {
  if (ctx.input.dryRun) {
    logger.info(`  [dry-run] skipping ${def.name}`)
    return { outcome: "completed", retries: 0 }
  }

  const verifyResult = runQualityGates(ctx.taskDir, ctx.projectDir, {
    skipTests: ctx.input.skipTests,
    tools: ctx.tools,
  })

  // Partition errors: those referencing files in the changeset (blocking)
  // vs those referencing only files outside the changeset (pre-existing noise).
  // When the gate fails but ALL errors are pre-existing, we pass the gate
  // with a "Skipped" section — the retrospective still captures the pattern.
  const modifiedFiles = verifyResult.pass ? [] : getModifiedFiles(ctx.projectDir)
  const inChangeset: string[] = []
  const preExisting: string[] = []
  for (const err of verifyResult.errors) {
    if (modifiedFiles.length === 0) {
      inChangeset.push(err)
    } else if (errorReferencesAnyOf(err, modifiedFiles)) {
      inChangeset.push(err)
    } else {
      // Only classify as pre-existing if the error line references SOME file
      // path at all — otherwise treat as inChangeset (safe default).
      const mentionsAnyPath = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java)\b/.test(err)
      if (mentionsAnyPath) preExisting.push(err)
      else inChangeset.push(err)
    }
  }

  const skipDueToPreExisting =
    !verifyResult.pass &&
    inChangeset.length === 0 &&
    preExisting.length > 0

  const effectivePass = verifyResult.pass || skipDueToPreExisting

  if (skipDueToPreExisting) {
    logger.warn(
      `  Verify gate: ${preExisting.length} pre-existing errors in unmodified files — passing gate (changeset-scoped)`,
    )
  }

  const lines: string[] = [
    `# Verification Report\n`,
    `## Result: ${effectivePass ? "PASS" : "FAIL"}${skipDueToPreExisting ? " (pre-existing errors skipped)" : ""}\n`,
  ]

  if (inChangeset.length > 0) {
    lines.push(`\n## Errors (in changeset)\n`)
    for (const e of inChangeset) {
      lines.push(`- ${e}\n`)
    }
  }

  if (preExisting.length > 0) {
    lines.push(`\n## Skipped pre-existing errors (unmodified files)\n`)
    for (const e of preExisting) {
      lines.push(`- ${e}\n`)
    }
  }

  if (verifyResult.summary.length > 0) {
    lines.push(`\n## Summary\n`)
    for (const s of verifyResult.summary) {
      lines.push(`- ${s}\n`)
    }
  }
  if (verifyResult.rawOutputs.length > 0) {
    lines.push(`\n## Raw Output\n`)
    for (const { name, output } of verifyResult.rawOutputs) {
      lines.push(`### ${name}\n\`\`\`\n${output}\n\`\`\`\n`)
    }
  }

  fs.writeFileSync(path.join(ctx.taskDir, "verify.md"), lines.join(""))

  return {
    outcome: effectivePass ? "completed" : "failed",
    retries: 0,
  }
}
