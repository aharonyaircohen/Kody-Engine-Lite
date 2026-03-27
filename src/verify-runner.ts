import { execFileSync } from "child_process"
import { getProjectConfig, VERIFY_COMMAND_TIMEOUT_MS } from "./config.js"
import { logger } from "./logger.js"

interface ExecError {
  stdout?: string
  stderr?: string
  killed?: boolean
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null
}

export interface VerifyResult {
  pass: boolean
  errors: string[]
  summary: string[]
}

/**
 * Parse a command string into [executable, ...args], respecting quoted arguments.
 * e.g., 'pnpm -s "test:unit"' → ["pnpm", "-s", "test:unit"]
 */
export function parseCommand(cmd: string): string[] {
  const parts: string[] = []
  let current = ""
  let inQuote: string | null = null

  for (const ch of cmd) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        parts.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  if (inQuote) logger.warn(`Unclosed quote in command: ${cmd}`)
  return parts
}

function runCommand(
  cmd: string,
  cwd: string,
  timeout: number,
): { success: boolean; output: string; timedOut: boolean } {
  const parts = parseCommand(cmd)
  if (parts.length === 0) {
    return { success: true, output: "", timedOut: false }
  }
  try {
    const output = execFileSync(parts[0], parts.slice(1), {
      cwd,
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    })
    return { success: true, output: output ?? "", timedOut: false }
  } catch (err: unknown) {
    const stdout = isExecError(err) ? err.stdout ?? "" : ""
    const stderr = isExecError(err) ? err.stderr ?? "" : ""
    const killed = isExecError(err) ? !!err.killed : false
    return { success: false, output: `${stdout}${stderr}`, timedOut: killed }
  }
}

function parseErrors(output: string): string[] {
  const errors: string[] = []
  for (const line of output.split("\n")) {
    if (/error|Error|ERROR|failed|Failed|FAIL|warning:|Warning:|WARN/i.test(line)) {
      errors.push(line.slice(0, 500))
    }
  }
  return errors
}

function extractSummary(output: string, cmdName: string): string[] {
  const summaryPatterns = /Test Suites|Tests|Coverage|ERRORS|FAILURES|success|completed/i
  const lines = output.split("\n").filter((l) => summaryPatterns.test(l))
  return lines.slice(-3).map((l) => `[${cmdName}] ${l.trim()}`)
}

export function runQualityGates(
  taskDir: string,
  projectRoot?: string,
): VerifyResult {
  const config = getProjectConfig()
  const cwd = projectRoot ?? process.cwd()
  const allErrors: string[] = []
  const allSummary: string[] = []
  let allPass = true

  const commands: Array<{ name: string; cmd: string }> = [
    { name: "typecheck", cmd: config.quality.typecheck },
    { name: "test", cmd: config.quality.testUnit },
  ]

  if (config.quality.lint) {
    commands.push({ name: "lint", cmd: config.quality.lint })
  }

  for (const { name, cmd } of commands) {
    if (!cmd) continue
    logger.info(`  Running ${name}: ${cmd}`)

    const result = runCommand(cmd, cwd, VERIFY_COMMAND_TIMEOUT_MS)

    if (result.timedOut) {
      allErrors.push(`${name}: timed out after ${VERIFY_COMMAND_TIMEOUT_MS / 1000}s`)
      allPass = false
      continue
    }

    if (!result.success) {
      allPass = false
      const errors = parseErrors(result.output)
      allErrors.push(...errors.map((e) => `[${name}] ${e}`))
    }

    allSummary.push(...extractSummary(result.output, name))
  }

  return { pass: allPass, errors: allErrors, summary: allSummary }
}
