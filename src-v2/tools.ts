/**
 * CLI-tool contract verifier.
 *
 * For each entry in a profile's `cliTools` array:
 *   1. Run `install.checkCommand`. If it exits non-zero and
 *      install.installCommand is set, run that and re-check.
 *   2. Run `verify` (e.g. `gh auth status`). Failure aborts the run.
 *   3. If the tool is `install.required: false` and still missing after
 *      install, leave it absent (the executable tolerates its absence).
 */

import { execFileSync } from "child_process"
import type { CliToolSpec } from "./executables/types.js"

export interface ToolCheckResult {
  name: string
  present: boolean
  verified: boolean
  error?: string
}

export function verifyCliTools(tools: CliToolSpec[], cwd?: string): ToolCheckResult[] {
  const out: ToolCheckResult[] = []
  for (const t of tools) out.push(verifyOne(t, cwd))
  return out
}

export function firstRequiredFailure(results: ToolCheckResult[], tools: CliToolSpec[]): ToolCheckResult | null {
  for (const t of tools) {
    const r = results.find((x) => x.name === t.name)
    if (!r) continue
    if (t.install.required && (!r.present || !r.verified)) return r
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────

function verifyOne(tool: CliToolSpec, cwd?: string): ToolCheckResult {
  const result: ToolCheckResult = { name: tool.name, present: false, verified: false }

  let present = runShell(tool.install.checkCommand, cwd)
  if (!present && tool.install.installCommand) {
    runShell(tool.install.installCommand, cwd, 120_000)
    present = runShell(tool.install.checkCommand, cwd)
  }
  result.present = present
  if (!present) {
    result.error = `tool "${tool.name}" not on PATH (check: ${tool.install.checkCommand})`
    return result
  }

  const verified = runShell(tool.verify, cwd)
  result.verified = verified
  if (!verified) result.error = `tool "${tool.name}" failed verify: ${tool.verify}`
  return result
}

function runShell(cmd: string, cwd?: string, timeoutMs = 30_000): boolean {
  try {
    execFileSync("sh", ["-c", cmd], { cwd, stdio: "pipe", timeout: timeoutMs })
    return true
  } catch { return false }
}
