import { execFileSync } from "child_process"
import { getProjectConfig, VERIFY_COMMAND_TIMEOUT_MS } from "./config.js"
import { logger } from "./logger.js"
import type { ResolvedTool } from "./types.js"

interface ExecError {
  stdout?: string
  stderr?: string
  killed?: boolean
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null &&
    ("stdout" in err || "stderr" in err || "killed" in err)
}

function getExecOutput(err: unknown): { stdout: string; stderr: string } {
  if (isExecError(err)) {
    return { stdout: (err as ExecError).stdout ?? "", stderr: (err as ExecError).stderr ?? "" }
  }
  return { stdout: "", stderr: "" }
}

export interface VerifyResult {
  pass: boolean
  errors: string[]
  summary: string[]
  rawOutputs: Array<{ name: string; output: string }>
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
    const { stdout, stderr } = getExecOutput(err)
    const killed = isExecError(err) ? !!(err as ExecError).killed : false
    return { success: false, output: `${stdout}${stderr}`, timedOut: killed }
  }
}

type ErrorExtractor = (output: string) => string[]

const ERROR_EXTRACTORS: Record<string, ErrorExtractor> = {
  tsc: (output) =>
    output
      .split("\n")
      .filter((l) => /^error TS\d+:/i.test(l) || (/\berror\b/i.test(l) && /\.ts\b/.test(l) && /(\(\d+,\d+\)|:\d+:\d+)/.test(l)))
      .map((l) => l.slice(0, 500)),
  eslint: (output) => {
    const lines = output.split("\n")
    const eslintErrors = lines.filter(
      (l) =>
        /^\s*(\d+:\d+\s+)?error /i.test(l) ||
        /✖ \d+ (problem|error)/i.test(l) ||
        (/error\b/i.test(l) && /\bfixable\b/i.test(l)),
    )
    // Fall back to raw output if no ESLint-formatted errors found
    if (eslintErrors.length === 0 && /\berror\b/i.test(output)) {
      return lines.filter((l) => l.trim()).map((l) => l.slice(0, 500))
    }
    return eslintErrors.map((l) => l.slice(0, 500))
  },
  vitest: (output) =>
    output
      .split("\n")
      .filter(
        (l) =>
          /^(FAIL|X)\s+.*\.test\./.test(l) ||
          /^\s*×|× \d+ (test|tests) failed/i.test(l) ||
          /AssertionError/.test(l),
      )
      .map((l) => l.slice(0, 500)),
  default: (output) =>
    output
      .split("\n")
      .filter((l) => /\berror\b/i.test(l) && /[A-Z]/.test(l.slice(0, 50)))
      .map((l) => l.slice(0, 500)),
}

const COMMAND_TO_EXTRACTOR: Record<string, string> = {
  typecheck: "tsc",
  lint: "eslint",
  test: "vitest",
  vitest: "vitest",
  eslint: "eslint",
  tsc: "tsc",
}

export function parseErrors(output: string, commandName?: string): string[] {
  const extractorKey = commandName ? (COMMAND_TO_EXTRACTOR[commandName] ?? "default") : "default"
  const extractor = ERROR_EXTRACTORS[extractorKey] ?? ERROR_EXTRACTORS.default
  const errors = extractor(output)
  return errors.length > 0 ? errors : []
}

function extractSummary(output: string, cmdName: string): string[] {
  const summaryPatterns = /Test Suites|Tests|Coverage|ERRORS|FAILURES|success|completed/i
  const lines = output.split("\n").filter((l) => summaryPatterns.test(l))
  return lines.slice(-3).map((l) => `[${cmdName}] ${l.trim()}`)
}

/**
 * Run a tool's quality gate command (e.g., `npx playwright test`).
 * The dev server is assumed to already be running from the build stage
 * (which starts it for UI tasks and keeps it as a detached process).
 */
function runToolCommand(
  tool: ResolvedTool,
  cwd: string,
): { success: boolean; output: string; timedOut: boolean } {
  if (!tool.run) return { success: true, output: "", timedOut: false }
  return runCommand(tool.run, cwd, VERIFY_COMMAND_TIMEOUT_MS)
}

export interface QualityGateOptions {
  /**
   * When set, typecheck errors are only treated as failures if they reference
   * one of these file paths. Errors in other files are logged as warnings and
   * treated as pre-existing (so conflict resolution isn't blocked by unrelated
   * issues already present in the codebase).
   */
  onlyFailOnFiles?: string[]
  /** Skip running unit tests (used by hotfix for fast-track verify). */
  skipTests?: boolean
  /** Tools from .kody/tools.yml to run as quality gates in the verify stage. */
  tools?: ResolvedTool[]
}

export function runQualityGates(
  taskDir: string,
  projectRoot?: string,
  options?: QualityGateOptions,
): VerifyResult {
  const config = getProjectConfig()
  const cwd = projectRoot ?? process.cwd()
  const allErrors: string[] = []
  const allSummary: string[] = []
  const rawOutputs: Array<{ name: string; output: string }> = []
  let allPass = true

  const commands: Array<{ name: string; cmd: string }> = [
    { name: "typecheck", cmd: config.quality.typecheck },
  ]
  if (!options?.skipTests) {
    commands.push({ name: "test", cmd: config.quality.testUnit })
  }

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
      const errors = parseErrors(result.output, name)

      // When onlyFailOnFiles is set for typecheck, suppress errors that only
      // mention files outside the provided set — these are pre-existing issues
      // unrelated to the current change.
      if (name === "typecheck" && options?.onlyFailOnFiles && options.onlyFailOnFiles.length > 0) {
        const scopedFiles = new Set(options.onlyFailOnFiles)
        const errorLines = errors.filter((e) => {
          // Only fail on errors that explicitly reference a scoped file.
          // Lines without a file path can't be attributed to a specific file,
          // so they're treated as pre-existing context and suppressed.
          const fileMatch = e.match(/\b(src\/[^\s(:]+\.[a-z]+)/)?.[1]
          if (!fileMatch) return false
          return scopedFiles.has(fileMatch) || options.onlyFailOnFiles!.some((f) => f.endsWith(fileMatch) || fileMatch.endsWith(f))
        })
        if (errorLines.length === 0) {
          logger.warn(`  [typecheck] errors found but none in scoped files — treating as pre-existing, skipping`)
          rawOutputs.push({ name, output: result.output.slice(-3000) })
          allSummary.push(...extractSummary(result.output, name))
          continue
        }
        allPass = false
        allErrors.push(...errorLines.map((e) => `[${name}] ${e}`))
        rawOutputs.push({ name, output: result.output.slice(-3000) })
      } else {
        allPass = false
        allErrors.push(...errors.map((e) => `[${name}] ${e}`))
        rawOutputs.push({ name, output: result.output.slice(-3000) })
      }
    }

    allSummary.push(...extractSummary(result.output, name))
  }

  // Run tools that target the "verify" stage (e.g., E2E tests from .kody/tools.yml)
  const verifyTools = (options?.tools ?? []).filter((t) => t.stages.includes("verify"))
  for (const tool of verifyTools) {
    if (!tool.run) continue
    logger.info(`  Running tool ${tool.name}: ${tool.run}`)
    const result = runToolCommand(tool, cwd)

    if (result.timedOut) {
      allErrors.push(`${tool.name}: timed out after ${VERIFY_COMMAND_TIMEOUT_MS / 1000}s`)
      allPass = false
      continue
    }

    if (!result.success) {
      allPass = false
      const errors = parseErrors(result.output)
      allErrors.push(...errors.length > 0
        ? errors.map((e) => `[${tool.name}] ${e}`)
        : [`[${tool.name}] ${result.output.slice(0, 500).trim()}`])
      rawOutputs.push({ name: tool.name, output: result.output.slice(-3000) })
    } else {
      allSummary.push(...extractSummary(result.output, tool.name))
    }
  }

  return { pass: allPass, errors: allErrors, summary: allSummary, rawOutputs }
}
