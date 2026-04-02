import { execFileSync } from "child_process"
import { mergeDefault, getConflictedFiles, commitAll, pushBranch, getDefaultBranch } from "./git-utils.js"
import { postPRComment } from "./github-api.js"
import { runQualityGates } from "./verify-runner.js"
import { logger } from "./logger.js"
import type { AgentRunner } from "./types.js"
import { resolveModel } from "./context.js"
import { getProjectConfig, anyStageNeedsProxy, getLitellmUrl } from "./config.js"

export interface ResolveOptions {
  prNumber: number
  projectDir: string
  runners: Record<string, AgentRunner>
  local: boolean
}

export interface ResolveResult {
  outcome: "merged" | "resolved" | "failed"
  error?: string
}

function getConflictContext(cwd: string, files: string[]): string {
  const parts: string[] = []
  for (const file of files.slice(0, 10)) {
    try {
      const content = execFileSync("git", ["diff", file], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      parts.push(`### ${file}\n\`\`\`diff\n${content.slice(0, 3000)}\n\`\`\``)
    } catch {
      parts.push(`### ${file}\n(could not read diff)`)
    }
  }
  return parts.join("\n\n")
}

/**
 * Attempt to merge the default branch into the current PR branch.
 * If there are conflicts, use an agent to resolve them, then verify.
 */
export async function runResolve(options: ResolveOptions): Promise<ResolveResult> {
  const { prNumber, projectDir, runners, local } = options
  const defaultBranch = getDefaultBranch(projectDir)

  // Step 1: Attempt merge (leaves conflict markers if any)
  logger.info(`Resolving PR #${prNumber} — merging ${defaultBranch}...`)
  const mergeResult = mergeDefault(projectDir)

  if (mergeResult === "error") {
    const error = "Failed to merge default branch"
    if (!local) {
      try { postPRComment(prNumber, `❌ **Resolve failed:** ${error}`) } catch { /* best effort */ }
    }
    return { outcome: "failed", error }
  }

  if (mergeResult === "clean") {
    logger.info("  Clean merge — no conflicts")
    if (!local) {
      pushBranch(projectDir)
      try { postPRComment(prNumber, `✅ **Clean merge** — synced with \`${defaultBranch}\`, no conflicts.`) } catch { /* best effort */ }
    }
    return { outcome: "merged" }
  }

  // Step 2: Get conflicted files
  const conflictedFiles = getConflictedFiles(projectDir)
  if (conflictedFiles.length === 0) {
    const error = "Merge reported conflict but no conflicted files found"
    if (!local) {
      try { postPRComment(prNumber, `❌ **Resolve failed:** ${error}`) } catch { /* best effort */ }
    }
    return { outcome: "failed", error }
  }
  logger.info(`  ${conflictedFiles.length} conflicted file(s): ${conflictedFiles.join(", ")}`)

  // Step 3: Run agent to resolve conflicts
  const conflictContext = getConflictContext(projectDir, conflictedFiles)
  const prompt = buildResolvePrompt(conflictedFiles, conflictContext, defaultBranch)

  const config = getProjectConfig()
  const runnerName = config.agent.defaultRunner ?? Object.keys(runners)[0] ?? "claude"
  const runner = runners[runnerName]
  if (!runner) {
    const error = `Runner "${runnerName}" not found`
    if (!local) {
      try { postPRComment(prNumber, `❌ **Resolve failed:** ${error}`) } catch { /* best effort */ }
    }
    return { outcome: "failed", error }
  }

  const model = resolveModel("mid")
  const extraEnv: Record<string, string> = {}
  if (anyStageNeedsProxy(config)) {
    extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
  }

  logger.info(`  Running agent to resolve conflicts (model=${model})...`)
  const result = await runner.run("resolve", prompt, model, 300_000, projectDir, {
    cwd: projectDir,
    env: extraEnv,
  })

  if (result.outcome !== "completed") {
    const error = `Agent failed: ${result.error}`
    if (!local) {
      try { postPRComment(prNumber, `❌ **Resolve failed:** ${error}`) } catch { /* best effort */ }
    }
    return { outcome: "failed", error }
  }

  // Step 4: Verify — typecheck scoped to conflicted files only (pre-existing
  // errors in unrelated files are suppressed), plus full lint + tests
  logger.info("  Verifying resolution...")
  const verify = runQualityGates(projectDir, projectDir, { onlyFailOnFiles: conflictedFiles })
  if (!verify.pass) {
    const errorSummary = verify.errors.slice(0, 5).join("\n")
    logger.error(`  Verification failed:\n${errorSummary}`)
    const error = `Conflict resolution failed verification:\n${errorSummary}`
    if (!local) {
      try { postPRComment(prNumber, `❌ **Resolve failed:** ${error}`) } catch { /* best effort */ }
    }
    return { outcome: "failed", error }
  }
  logger.info("  Verification passed")

  // Step 5: Commit + push
  commitAll(`chore: resolve merge conflicts with ${defaultBranch}`, projectDir)

  if (!local) {
    pushBranch(projectDir)

    try {
      const fileList = conflictedFiles.map((f) => `- \`${f}\``).join("\n")
      postPRComment(
        prNumber,
        `✅ **Merge conflicts resolved** with \`${defaultBranch}\`\n\n**Conflicted files:**\n${fileList}\n\n_Verification passed. Please review the resolution._`,
      )
    } catch { /* best effort */ }
  }

  return { outcome: "resolved" }
}

function buildResolvePrompt(
  files: string[],
  conflictContext: string,
  defaultBranch: string,
): string {
  return `You are resolving merge conflicts between a feature branch and the \`${defaultBranch}\` branch.

## Conflicted files
${files.map((f) => `- ${f}`).join("\n")}

## Conflict diffs
${conflictContext}

## Instructions
1. Read each conflicted file
2. Resolve the conflict markers (<<<<<<< / ======= / >>>>>>>) by combining both sides correctly:
   - For feature/business logic: preserve the PR branch's intent
   - For infrastructure/config/dependencies: prefer the \`${defaultBranch}\` branch
   - For imports/types: merge both sides
3. Write the resolved file using the Edit or Write tool
4. Do NOT add new features or refactor — only resolve the conflicts
5. After resolving all files, run \`git add .\` to stage the resolution`
}
