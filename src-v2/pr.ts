import { gh, truncate } from "./issue.js"

export interface PrResult {
  url: string
  number: number
  draft: boolean
  action: "created" | "updated"
}

export interface EnsurePrOptions {
  branch: string
  defaultBranch: string
  issueNumber: number
  issueTitle: string
  draft: boolean
  failureReason?: string
  changedFiles: string[]
  cwd?: string
}

const TITLE_MAX = 72

export function buildPrTitle(issueNumber: number, issueTitle: string, draft: boolean): string {
  const prefix = draft ? "[WIP] " : ""
  const base = `${prefix}#${issueNumber}: ${issueTitle}`
  if (base.length <= TITLE_MAX) return base
  return base.slice(0, TITLE_MAX - 1) + "…"
}

export function buildPrBody(opts: EnsurePrOptions): string {
  const lines: string[] = []

  if (opts.draft && opts.failureReason) {
    const headline = firstLine(opts.failureReason)
    lines.push(`> ⚠️ Draft: ${headline}`)
    lines.push(`> The failures below may be **pre-existing in the repo** — verify before treating as PR-blocking.`)
    lines.push("")
  }

  lines.push("## Summary")
  lines.push("")
  lines.push(`Implementation of issue #${opts.issueNumber} — ${opts.issueTitle}`)
  lines.push("")

  if (opts.changedFiles.length > 0) {
    lines.push("## Changes")
    lines.push("")
    for (const f of opts.changedFiles.slice(0, 50)) lines.push(`- \`${f}\``)
    if (opts.changedFiles.length > 50) lines.push(`- … and ${opts.changedFiles.length - 50} more`)
    lines.push("")
  }

  lines.push(`Closes #${opts.issueNumber}`)
  lines.push("")

  if (opts.draft && opts.failureReason) {
    lines.push("<details>")
    lines.push("<summary>Verify output (click to expand)</summary>")
    lines.push("")
    lines.push("```")
    lines.push(truncate(opts.failureReason, 6000))
    lines.push("```")
    lines.push("")
    lines.push("</details>")
    lines.push("")
  }

  lines.push("---")
  lines.push("_Opened by kody-lean (single-session autonomous run)._ ")
  return lines.join("\n")
}

function firstLine(s: string): string {
  const trimmed = s.trim()
  const nl = trimmed.indexOf("\n")
  const head = nl === -1 ? trimmed : trimmed.slice(0, nl)
  return head.length > 200 ? head.slice(0, 197) + "…" : head
}

export function findExistingPr(branch: string, cwd?: string): { number: number; url: string } | null {
  try {
    const output = gh(["pr", "view", branch, "--json", "number,url"], { cwd })
    const parsed = JSON.parse(output)
    if (typeof parsed?.number === "number" && typeof parsed?.url === "string") {
      return { number: parsed.number, url: parsed.url }
    }
    return null
  } catch {
    return null
  }
}

export function ensurePr(opts: EnsurePrOptions): PrResult {
  const title = buildPrTitle(opts.issueNumber, opts.issueTitle, opts.draft)
  const body = buildPrBody(opts)

  const existing = findExistingPr(opts.branch, opts.cwd)
  if (existing) {
    try {
      gh(
        ["pr", "edit", String(existing.number), "--title", title, "--body-file", "-"],
        { input: body, cwd: opts.cwd },
      )
    } catch (err) {
      process.stderr.write(`[kody-lean] failed to update PR #${existing.number}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    return { url: existing.url, number: existing.number, draft: opts.draft, action: "updated" }
  }

  const args = [
    "pr", "create",
    "--head", opts.branch,
    "--base", opts.defaultBranch,
    "--title", title,
    "--body-file", "-",
  ]
  if (opts.draft) args.push("--draft")

  const output = gh(args, { input: body, cwd: opts.cwd })
  const url = output.trim()
  const match = url.match(/\/pull\/(\d+)$/)
  const number = match ? parseInt(match[1], 10) : 0
  return { url, number, draft: opts.draft, action: "created" }
}
