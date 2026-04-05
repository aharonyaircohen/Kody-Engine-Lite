import * as fs from "fs"
import * as path from "path"

import type {
  StageDefinition,
  StageResult,
  PipelineContext,
} from "../types.js"
import { runQualityGates } from "../verify-runner.js"
import { logger } from "../logger.js"

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
  })

  const lines: string[] = [
    `# Verification Report\n`,
    `## Result: ${verifyResult.pass ? "PASS" : "FAIL"}\n`,
  ]
  if (verifyResult.errors.length > 0) {
    lines.push(`\n## Errors\n`)
    for (const e of verifyResult.errors) {
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
    outcome: verifyResult.pass ? "completed" : "failed",
    retries: 0,
  }
}
