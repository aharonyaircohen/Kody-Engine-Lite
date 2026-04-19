/**
 * Shared preflight: assemble the final prompt string from:
 *   - profile.dir/prompt.md (template with {{mustache}} tokens)
 *   - context data populated by the flow script (issue, pr, feedback, diff, …)
 *   - conventions
 *   - coverage rules
 *   - claudeCode.systemPromptAppend and cliTools[].usage (tool guidance)
 *
 * No role-specific branching — every token the template references is
 * looked up in ctx.data or ctx.args. Missing tokens render as an empty
 * string (fail-soft).
 */

import * as fs from "fs"
import * as path from "path"
import type { PreflightScript, Profile } from "../executables/types.js"
import type { LoadedConvention } from "../prompt.js"

const MUSTACHE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

export const composePrompt: PreflightScript = async (ctx, profile) => {
  const templatePath = path.join(profile.dir, "prompt.md")
  if (!fs.existsSync(templatePath)) {
    throw new Error(`profile at ${profile.dir} is missing prompt.md`)
  }
  const template = fs.readFileSync(templatePath, "utf-8")

  const tokens: Record<string, string> = {
    ...stringifyAll(ctx.args, "args."),
    ...stringifyAll(ctx.data, ""),
    "conventionsBlock": formatConventions(ctx.data.conventions as LoadedConvention[] | undefined),
    "coverageBlock": formatCoverageBlock(ctx.data.coverageRules as { pattern: string; requireSibling: string }[] | undefined),
    "toolsUsage": formatToolsUsage(profile),
    "systemPromptAppend": profile.claudeCode.systemPromptAppend ?? "",
    "repoOwner": ctx.config.github.owner,
    "repoName": ctx.config.github.repo,
    "defaultBranch": ctx.config.git.defaultBranch,
    "branch": (ctx.data.branch as string) ?? "",
  }

  ctx.data.prompt = template.replace(MUSTACHE, (_, key) => tokens[key] ?? "")
}

function stringifyAll(source: Record<string, unknown>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    const key = prefix + k
    if (v === null || v === undefined) continue
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = String(v)
    } else if (Array.isArray(v)) {
      out[key] = v.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join("\n")
    } else if (typeof v === "object") {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === "string" || typeof v2 === "number" || typeof v2 === "boolean") {
          out[`${key}.${k2}`] = String(v2)
        }
      }
    }
  }
  return out
}

function formatConventions(conventions: LoadedConvention[] | undefined): string {
  if (!conventions || conventions.length === 0) return ""
  const lines = [
    "# Project conventions (AUTHORITATIVE — follow these over patterns you infer from code)",
    "",
  ]
  for (const c of conventions) {
    lines.push(`## ${c.path}${c.truncated ? " (truncated)" : ""}`)
    lines.push("")
    lines.push("```")
    lines.push(c.content)
    lines.push("```")
    lines.push("")
  }
  return lines.join("\n")
}

function formatCoverageBlock(reqs: { pattern: string; requireSibling: string }[] | undefined): string {
  if (!reqs || reqs.length === 0) return ""
  const lines = [
    "# Test coverage requirements (ENFORCED)",
    "",
    "Every newly added file matching one of these patterns MUST be accompanied by a sibling test file in the same commit. The wrapper checks this after you finish; if any sibling test is missing, the run will fail and the issue will be re-invoked with the gap as feedback.",
    "",
  ]
  for (const r of reqs) lines.push(`- new \`${r.pattern}\` → must include sibling \`${r.requireSibling}\``)
  lines.push("")
  return lines.join("\n")
}

function formatToolsUsage(profile: Profile): string {
  const entries = (profile.cliTools ?? []).filter((t) => t.usage.trim().length > 0)
  if (entries.length === 0) return ""
  const lines = [
    "# Available CLI tools",
    "",
  ]
  for (const t of entries) {
    lines.push(`## \`${t.name}\``)
    lines.push(t.usage)
    if (t.allowedUses.length > 0) {
      lines.push(`Allowed sub-commands: ${t.allowedUses.map((u) => "`" + u + "`").join(", ")}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}
