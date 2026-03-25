import { execFileSync } from "child_process"
import * as fs from "fs"
import { logger } from "./logger.js"

interface CheckResult {
  name: string
  ok: boolean
  detail?: string
}

function check(name: string, fn: () => string | void): CheckResult {
  try {
    const detail = fn() ?? undefined
    return { name, ok: true, detail }
  } catch {
    return { name, ok: false }
  }
}

export function runPreflight(): void {
  const checks: CheckResult[] = [
    check("claude CLI", () => {
      const v = execFileSync("claude", ["--version"], {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      return v
    }),
    check("git repo", () => {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
    }),
    check("pnpm", () => {
      const v = execFileSync("pnpm", ["--version"], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      return v
    }),
    check("node >= 18", () => {
      const v = execFileSync("node", ["--version"], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      const major = parseInt(v.replace("v", "").split(".")[0], 10)
      if (major < 18) throw new Error(`Node ${v} < 18`)
      return v
    }),
    check("gh CLI", () => {
      const v = execFileSync("gh", ["--version"], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim().split("\n")[0]
      return v
    }),
    check("package.json", () => {
      if (!fs.existsSync("package.json")) throw new Error("not found")
    }),
  ]

  const failed = checks.filter((c) => !c.ok)

  for (const c of checks) {
    logger.info(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`)
  }

  if (failed.length > 0) {
    throw new Error(
      `Preflight failed: ${failed.map((c) => c.name).join(", ")}`,
    )
  }
}
