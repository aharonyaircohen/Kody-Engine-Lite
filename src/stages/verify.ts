import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import type {
  StageName,
  StageDefinition,
  StageResult,
  PipelineContext,
} from "../types.js"
import { resolveModel } from "../context.js"
import { getProjectConfig, FIX_COMMAND_TIMEOUT_MS, anyStageNeedsProxy, getLitellmUrl } from "../config.js"
import { parseCommand } from "../verify-runner.js"
import { getRunnerForStage } from "../pipeline/runner-selection.js"
import { postComment } from "../github-api.js"
import { diagnoseFailure, getModifiedFiles, errorReferencesAnyOf } from "../observer.js"
import { logger } from "../logger.js"
import { executeAgentStage } from "./agent.js"
import { executeGateStage } from "./gate.js"

export async function executeVerifyWithAutofix(
  ctx: PipelineContext,
  def: StageDefinition,
): Promise<StageResult> {
  const maxAttempts = def.maxRetries ?? 2

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    logger.info(`  verification attempt ${attempt + 1}/${maxAttempts + 1}`)

    const gateResult = executeGateStage(ctx, def)
    if (gateResult.outcome === "completed") {
      return { ...gateResult, retries: attempt }
    }

    if (attempt < maxAttempts) {
      // Read verify errors for diagnosis
      const verifyPath = path.join(ctx.taskDir, "verify.md")
      const errorOutput = fs.existsSync(verifyPath) ? fs.readFileSync(verifyPath, "utf-8") : "Unknown error"

      // AI diagnosis — classify the failure
      const modifiedFiles = getModifiedFiles(ctx.projectDir)
      const defaultRunner = getRunnerForStage(ctx, "taskify") // use cheap model
      const diagConfig = getProjectConfig()
      const diagEnv: Record<string, string> = {}
      if (anyStageNeedsProxy(diagConfig)) {
        diagEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
      }
      const diagnosis = await diagnoseFailure(
        "verify",
        errorOutput,
        modifiedFiles,
        defaultRunner,
        resolveModel("cheap"),
        { cwd: ctx.projectDir, env: diagEnv },
      )

      if (diagnosis.classification === "infrastructure") {
        logger.warn(`  Infrastructure issue: ${diagnosis.reason}`)
        if (ctx.input.issueNumber && !ctx.input.local) {
          try {
            postComment(ctx.input.issueNumber, `⚠️ **Infrastructure issue detected:** ${diagnosis.reason}\n\n${diagnosis.resolution}`)
          } catch { /* fire-and-forget */ }
        }
        return { outcome: "completed", retries: attempt, error: `Skipped: ${diagnosis.reason}` }
      }

      if (diagnosis.classification === "pre-existing") {
        logger.warn(`  Pre-existing issue: ${diagnosis.reason}`)
        return { outcome: "completed", retries: attempt, error: `Skipped: ${diagnosis.reason}` }
      }

      if (diagnosis.classification === "abort") {
        logger.error(`  Unrecoverable: ${diagnosis.reason}`)
        return { outcome: "failed", retries: attempt, error: diagnosis.reason }
      }

      // fixable or retry — proceed with autofix
      logger.info(`  Diagnosis: ${diagnosis.classification} — ${diagnosis.reason}`)

      // Pre-autofix sanity check: if NONE of the current errors reference
      // a file in the changeset, autofix cannot legitimately help — any
      // edits it makes will be to unmodified files, which is exactly how
      // the 1→12-errors regression happens. Skip autofix and treat as
      // pre-existing.
      const errorsInChangeset = modifiedFiles.length > 0
        ? errorOutput
            .split("\n")
            .filter((l) => /error|Error|ERROR|failed|Failed|FAIL/i.test(l))
            .some((l) => errorReferencesAnyOf(l, modifiedFiles))
        : true

      if (!errorsInChangeset) {
        logger.warn(
          "  Autofix pre-check: no errors reference any file in the changeset — " +
          "skipping autofix to avoid modifying unrelated files.",
        )
        return {
          outcome: "completed",
          retries: attempt,
          error: "Skipped: all errors outside changeset",
        }
      }

      const config = getProjectConfig()
      const runFix = (cmd: string) => {
        if (!cmd) return
        const parts = parseCommand(cmd)
        if (parts.length === 0) return
        try {
          execFileSync(parts[0], parts.slice(1), {
            stdio: "pipe",
            timeout: FIX_COMMAND_TIMEOUT_MS,
          })
        } catch {
          // Silently ignore fix failures
        }
      }

      runFix(config.quality.lintFix)
      runFix(config.quality.formatFix)

      if (def.retryWithAgent) {
        // Scope-guard: constrain the autofix agent to edit only files
        // already in the changeset. Prevents the regression where autofix
        // "fixes" unrelated files and introduces new errors.
        const scopeGuard = modifiedFiles.length > 0
          ? `\n\nSCOPE RESTRICTION: You MUST ONLY edit these files. Do not modify any other file:\n${modifiedFiles.map((f) => `  - ${f}`).join("\n")}\n`
          : ""

        // Create new context with diagnosis guidance — don't mutate original
        const autofixCtx: PipelineContext = {
          ...ctx,
          input: {
            ...ctx.input,
            feedback: `${diagnosis.resolution}${scopeGuard}\n\n${ctx.input.feedback ?? ""}`.trim(),
          },
        }

        logger.info(`  running ${def.retryWithAgent} agent with diagnosis guidance (scope: ${modifiedFiles.length} file${modifiedFiles.length === 1 ? "" : "s"})...`)
        await executeAgentStage(autofixCtx, {
          ...def,
          name: def.retryWithAgent as StageName,
          type: "agent",
          modelTier: "mid",
          timeout: 300_000,
          outputFile: undefined,
        })
      }
    }
  }

  return {
    outcome: "failed",
    retries: maxAttempts,
    error: "Verification failed after autofix attempts",
  }
}
