import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import { logger } from "../logger.js"
import type {
  StageDefinition,
  StageResult,
  PipelineContext,
} from "../types.js"
import {
  getCurrentBranch,
  getDefaultBranch,
  pushBranch,
} from "../git-utils.js"
import {
  postComment,
  postPRComment,
  createPR,
  getPRForBranch,
  updatePR,
} from "../github-api.js"
import { getProjectConfig } from "../config.js"

/**
 * Pure predicate for the fix-mode ship guard. Returns true when the pipeline
 * ran fix/fix-ci with non-empty feedback but produced no source-file changes —
 * that combination means human scope was dropped silently, and ship should
 * fail loudly instead of pushing an empty commit.
 */
export function shouldFailFixModeShip(
  command: string | undefined,
  feedback: string | undefined,
  hasSourceChanges: boolean,
): boolean {
  if (command !== "fix" && command !== "fix-ci") return false
  if (!feedback?.trim()) return false
  return !hasSourceChanges
}

/**
 * Paths the engine maintains for its own bookkeeping — these don't count as
 * "source changes" for the fix-mode ship guard. Edit with care: any path added
 * here becomes invisible to the guard, so the pipeline could silently ship a
 * no-op fix whose only changes are under these prefixes.
 */
const KODY_ARTIFACT_PREFIXES = [".kody/", ".kody-engine/"] as const

export function isKodyArtifactPath(filePath: string): boolean {
  return KODY_ARTIFACT_PREFIXES.some((prefix) => filePath.startsWith(prefix))
}

/**
 * Detect whether any source file (outside Kody's own bookkeeping dirs) changed
 * between `ref` and current HEAD. Exported for tests and for callers that need
 * to scope the comparison to a specific ref (e.g. the pre-fix HEAD captured at
 * the start of a fix run, rather than the default branch).
 */
export function detectSourceChangesSinceRef(projectDir: string, ref: string): boolean {
  try {
    const diff = execFileSync(
      "git",
      ["diff", "--name-only", `${ref}...HEAD`],
      { cwd: projectDir, encoding: "utf-8", stdio: "pipe" },
    )
    return diff
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .some((f) => !isKodyArtifactPath(f))
  } catch {
    // If git diff fails (e.g. detached HEAD, missing ref), don't block ship —
    // the guard is a safety net, not a hard invariant.
    return true
  }
}

function detectSourceChangesVsBase(projectDir: string, base: string): boolean {
  return detectSourceChangesSinceRef(projectDir, base)
}

export function buildPrBody(ctx: PipelineContext): string {
  const sections: string[] = []

  // What and why — from task.json
  const taskJsonPath = path.join(ctx.taskDir, "task.json")
  if (fs.existsSync(taskJsonPath)) {
    try {
      const raw = fs.readFileSync(taskJsonPath, "utf-8")
      const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
      const task = JSON.parse(cleaned)
      if (task.description) {
        sections.push(`## What\n\n${task.description}`)
      }
      if (task.scope?.length) {
        sections.push(`\n## Scope\n\n${task.scope.map((s: string) => `- \`${s}\``).join("\n")}`)
      }
      sections.push(`\n**Type:** ${task.task_type ?? "unknown"} | **Risk:** ${task.risk_level ?? "unknown"}`)
    } catch { /* ignore parse errors */ }
  }

  // Changes — from review.md summary
  const reviewPath = path.join(ctx.taskDir, "review.md")
  if (fs.existsSync(reviewPath)) {
    const review = fs.readFileSync(reviewPath, "utf-8")
    const summaryMatch = review.match(/## Summary\s*\n([\s\S]*?)(?=\n## |\n*$)/)
    if (summaryMatch) {
      const summary = summaryMatch[1].trim()
      if (summary) {
        sections.push(`\n## Changes\n\n${summary}`)
      }
    }
    const verdictMatch = review.match(/## Verdict:\s*(PASS|FAIL)/i)
    if (verdictMatch) {
      sections.push(`\n**Review:** ${verdictMatch[1].toUpperCase() === "PASS" ? "✅ PASS" : "❌ FAIL"}`)
    }
  }

  // Verify result
  const verifyPath = path.join(ctx.taskDir, "verify.md")
  if (fs.existsSync(verifyPath)) {
    const verify = fs.readFileSync(verifyPath, "utf-8")
    if (/PASS/i.test(verify)) sections.push(`**Verify:** ✅ typecheck + tests + lint passed`)
  }

  // Plan — collapsible details
  const planPath = path.join(ctx.taskDir, "plan.md")
  if (fs.existsSync(planPath)) {
    const plan = fs.readFileSync(planPath, "utf-8").trim()
    if (plan) {
      const truncated = plan.length > 800 ? plan.slice(0, 800) + "\n..." : plan
      sections.push(`\n<details><summary>📋 Implementation plan</summary>\n\n${truncated}\n</details>`)
    }
  }

  // Decompose info (if this was a decomposed task)
  const decomposeStatePath = path.join(ctx.taskDir, "decompose-state.json")
  if (fs.existsSync(decomposeStatePath)) {
    try {
      const ds = JSON.parse(fs.readFileSync(decomposeStatePath, "utf-8"))
      if (ds.decompose?.decomposable && Array.isArray(ds.decompose?.sub_tasks)) {
        const subList = ds.decompose.sub_tasks
          .map((st: { id: string; title: string; scope: string[] }) =>
            `- **${st.id}:** ${st.title} (${st.scope.length} files)`)
          .join("\n")
        sections.push(`\n## Decomposed Implementation\nThis task was split into ${ds.decompose.sub_tasks.length} parallel sub-tasks:\n${subList}`)
      }
    } catch { /* ignore parse errors */ }
  }

  // Closes issue
  if (ctx.input.issueNumber) {
    sections.push(`\nCloses #${ctx.input.issueNumber}`)
  }

  // Rollback plan
  sections.push(`
## Rollback Plan

If this change causes problems:
1. **Quick revert:** \`git revert <commit> && git push\`
2. **Full rollback:** switch back to the previous release tag
3. **Database migration:** check if any migration is reversible — if not, backfill data before deploying this change`)

  sections.push(`\n---\n🤖 Generated by Kody`)

  return sections.join("\n")
}

export function executeShipStage(
  ctx: PipelineContext,
  _def: StageDefinition,
): StageResult {
  const shipPath = path.join(ctx.taskDir, "ship.md")

  if (ctx.input.dryRun) {
    fs.writeFileSync(shipPath, "# Ship\n\nShip stage skipped — dry run.\n")
    return { outcome: "completed", outputFile: "ship.md", retries: 0 }
  }

  // Local mode or no issue: skip git push + PR
  if (ctx.input.local && !ctx.input.issueNumber) {
    fs.writeFileSync(shipPath, "# Ship\n\nShip stage skipped — local mode, no issue number.\n")
    return { outcome: "completed", outputFile: "ship.md", retries: 0 }
  }

  try {
    const head = getCurrentBranch(ctx.projectDir)
    const base = getDefaultBranch(ctx.projectDir)

    // Fix-mode guard: if the human supplied feedback but no source file (outside
    // .kody/) changed during THIS run, the pipeline silently dropped new scope.
    // Fail loudly so it can't slip through as an empty artifact commit.
    //
    // Compare against `preFixHead` (captured at fix-run start) when available —
    // diffing against the default branch wrongly counts the PR's pre-existing
    // changes and makes the guard a no-op on any non-empty PR.
    const compareRef = ctx.input.preFixHead ?? base
    if (shouldFailFixModeShip(
      ctx.input.command,
      ctx.input.feedback,
      detectSourceChangesSinceRef(ctx.projectDir, compareRef),
    )) {
      const msg =
        "fix-mode with non-empty feedback produced no source-file changes — failing ship to surface the dropped scope"
      logger.error(`  ${msg}`)
      fs.writeFileSync(shipPath, `# Ship\n\nFAILED: ${msg}\n`)
      return { outcome: "failed", outputFile: "ship.md", retries: 0, error: msg }
    }

    // Commit task artifacts (.kody/tasks/), memory updates (.kody/memory/),
    // and graph facts (.kody/graph/) so they persist in the PR
    try {
      const memoryDir = path.join(ctx.projectDir, ".kody", "memory")
      const graphDir = path.join(ctx.projectDir, ".kody", "graph")
      const addPaths = [ctx.taskDir]
      if (fs.existsSync(memoryDir)) addPaths.push(memoryDir)
      if (fs.existsSync(graphDir)) addPaths.push(graphDir)

      // Check for uncommitted changes before adding
      const statusBefore = execFileSync("git", ["status", "--porcelain"], {
        cwd: ctx.projectDir,
        encoding: "utf-8",
        env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
        stdio: "pipe",
      })
      if (!statusBefore.trim()) {
        logger.info("  No changes to commit")
      } else {
        logger.info(`  Changes pending: ${statusBefore.trim().split("\n").slice(0, 3).join(", ")}`)
      }

      execFileSync("git", ["add", ...addPaths], {
        cwd: ctx.projectDir,
        env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
        stdio: "pipe",
      })
      execFileSync("git", ["commit", "--no-gpg-sign", "-m", `chore: add kody task artifacts [skip ci]`], {
        cwd: ctx.projectDir,
        env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
        stdio: "pipe",
      })
      logger.info("  Committed task artifacts + graph memory")
    } catch (err) {
      // No task artifacts to commit, or already committed — continue
      logger.info(`  No artifacts to commit (or git conflict): ${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)}`)
    }

    pushBranch(ctx.projectDir)

    // Resolve owner/repo
    const config = getProjectConfig()
    let owner = config.github?.owner
    let repo = config.github?.repo

    if (!owner || !repo) {
      try {
        const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
          encoding: "utf-8",
          cwd: ctx.projectDir,
        }).trim()
        const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
        if (match) {
          owner = match[1]
          repo = match[2]
        }
      } catch {
        // Can't determine repo
      }
    }

    // Derive PR title: use issue title (user-written, always clean) with
    // task_type prefix from task.json for conventional commit format.
    let title = "Update"
    const TYPE_PREFIX: Record<string, string> = {
      feature: "feat",
      bugfix: "fix",
      refactor: "refactor",
      docs: "docs",
      chore: "chore",
    }

    // Get type prefix from task.json
    let prefix = "chore"
    const taskJsonPath = path.join(ctx.taskDir, "task.json")
    if (fs.existsSync(taskJsonPath)) {
      try {
        const raw = fs.readFileSync(taskJsonPath, "utf-8")
        const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
        const task = JSON.parse(cleaned)
        prefix = TYPE_PREFIX[task.task_type] ?? "chore"
      } catch { /* ignore */ }
    }

    // Get title from task.md (sourced from issue title — the user's own words)
    const taskMdPath = path.join(ctx.taskDir, "task.md")
    if (fs.existsSync(taskMdPath)) {
      const content = fs.readFileSync(taskMdPath, "utf-8")
      const heading = content.split("\n").find((l) => l.startsWith("# "))
      if (heading) {
        title = `${prefix}: ${heading.replace(/^#\s*/, "").trim()}`.slice(0, 72)
      }
    }

    if (title === "Update") {
      // Last resort: use task.json title
      if (fs.existsSync(taskJsonPath)) {
        try {
          const raw = fs.readFileSync(taskJsonPath, "utf-8")
          const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
          const task = JSON.parse(cleaned)
          if (task.title) title = `${prefix}: ${task.title}`.slice(0, 72)
        } catch { /* ignore */ }
      }
    }

    // Build rich PR body
    const body = buildPrBody(ctx)

    // Check if a PR already exists for this branch (e.g. fix on existing PR)
    const existingPr = getPRForBranch(head)

    if (existingPr) {
      // PR exists — update its body with latest review/verify info
      updatePR(existingPr.number, body)

      if (!ctx.input.local) {
        const msg = `✅ Fix pushed to PR #${existingPr.number}: ${existingPr.url}`
        try {
          // For PR-based fix: post on the PR itself
          if (ctx.input.prNumber) {
            postPRComment(ctx.input.prNumber, msg)
          } else if (ctx.input.issueNumber) {
            postComment(ctx.input.issueNumber, msg)
          }
        } catch {
          // Fire and forget
        }
      }

      fs.writeFileSync(shipPath, `# Ship\n\nUpdated existing PR: ${existingPr.url}\nPR #${existingPr.number}\n`)
    } else {
      let pr = createPR(head, base, title, body)

      // gh pr create can fail on response read-back even when the PR was created
      // (known GitHub GraphQL issue). Check if the PR actually exists.
      if (!pr) {
        const recovered = getPRForBranch(head)
        if (recovered) {
          logger.info(`  PR recovered after create error: ${recovered.url}`)
          pr = recovered
        }
      }

      if (pr) {
        if (ctx.input.issueNumber && !ctx.input.local) {
          try {
            postComment(ctx.input.issueNumber, `🎉 PR created: ${pr.url}`)
          } catch {
            // Fire and forget
          }
          // Don't close the issue here — "Closes #N" in the PR body will
          // auto-close it when the PR is merged. Closing prematurely means
          // the issue disappears before the code is actually merged.
        }

        fs.writeFileSync(shipPath, `# Ship\n\nPR created: ${pr.url}\nPR #${pr.number}\n`)
      } else {
        fs.writeFileSync(shipPath, "# Ship\n\nPushed branch but failed to create PR.\n")
        return { outcome: "failed", outputFile: "ship.md", retries: 0, error: "PR creation failed" }
      }
    }

    return { outcome: "completed", outputFile: "ship.md", retries: 0 }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      fs.writeFileSync(shipPath, `# Ship\n\nFailed: ${msg}\n`)
    } catch {
      // ship.md write failure is non-critical — don't mask the original error
      logger.warn(`  Failed to write ship.md artifact`)
    }
    return { outcome: "failed", retries: 0, error: msg }
  }
}
