/**
 * Flow script for `args.mode === "resolve"`.
 * Loads PR, checks it out, attempts to merge origin/<base>. On clean merge,
 * sets ctx.skipAgent = true and marks success. On conflict, collects the
 * conflicted files + markers preview for the agent to resolve.
 */

import { execFileSync } from "child_process"
import { getPr, postPrReviewComment } from "../issue.js"
import { checkoutPrBranch, getCurrentBranch, mergeBase } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"

const CONFLICT_DIFF_MAX_BYTES = 40_000

export const resolveFlow: PreflightScript = async (ctx) => {
  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)
  if (pr.state !== "OPEN") {
    ctx.output.exitCode = 1
    ctx.output.reason = `PR #${prNumber} is not OPEN (state: ${pr.state})`
    ctx.skipAgent = true
    return
  }
  ctx.data.pr = pr
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = prNumber

  checkoutPrBranch(prNumber, ctx.cwd)
  ctx.data.branch = getCurrentBranch(ctx.cwd)

  const baseBranch = pr.baseRefName || ctx.config.git.defaultBranch
  ctx.data.baseBranch = baseBranch

  const mergeStatus = mergeBase(baseBranch, ctx.cwd)
  if (mergeStatus === "clean") {
    ctx.output.exitCode = 0
    ctx.output.reason = `already up to date with origin/${baseBranch} — nothing to resolve`
    ctx.skipAgent = true
    tryPostPr(prNumber, `ℹ️ kody2 resolve: ${ctx.output.reason}`, ctx.cwd)
    return
  }
  if (mergeStatus === "error") {
    ctx.output.exitCode = 99
    ctx.output.reason = `failed to merge origin/${baseBranch} (non-conflict error); see runner log`
    ctx.skipAgent = true
    tryPostPr(prNumber, `⚠️ kody2 resolve FAILED: ${ctx.output.reason}`, ctx.cwd)
    return
  }

  const conflictedFiles = getConflictedFiles(ctx.cwd)
  if (conflictedFiles.length === 0) {
    ctx.output.exitCode = 99
    ctx.output.reason = "merge reported conflict but no unmerged paths detected"
    ctx.skipAgent = true
    return
  }

  ctx.data.conflictedFiles = conflictedFiles
  ctx.data.conflictMarkersPreview = getConflictMarkersPreview(conflictedFiles, ctx.cwd)
  tryPostPr(prNumber, `⚙️ kody2 resolve started on \`${ctx.data.branch}\` — ${conflictedFiles.length} conflicted file(s)`, ctx.cwd)
}

function getConflictedFiles(cwd?: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, HUSKY: "0" },
    }).trim()
    return out ? out.split("\n").filter(Boolean) : []
  } catch { return [] }
}

function getConflictMarkersPreview(files: string[], cwd?: string, maxBytes = CONFLICT_DIFF_MAX_BYTES): string {
  const chunks: string[] = []
  let total = 0
  for (const f of files) {
    try {
      const content = execFileSync("cat", [f], { encoding: "utf-8", cwd }).toString()
      const snippet = `### ${f}\n\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\`\n`
      total += snippet.length
      chunks.push(snippet)
      if (total >= maxBytes) break
    } catch { /* skip */ }
  }
  return chunks.join("\n")
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try { postPrReviewComment(prNumber, body, cwd) } catch { /* best effort */ }
}
