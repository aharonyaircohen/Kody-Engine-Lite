import { execFileSync } from "child_process"
import { logger } from "./logger.js"
import { parseJsonSafe } from "./validators.js"
import type { AgentRunner } from "./types.js"

export type FailureClassification =
  | "fixable"
  | "infrastructure"
  | "pre-existing"
  | "retry"
  | "abort"

export interface DiagnosisResult {
  classification: FailureClassification
  reason: string
  resolution: string
}

const DIAGNOSIS_PROMPT = `You are a pipeline failure diagnosis agent. Analyze the error output and classify it.

Output ONLY valid JSON. No markdown fences. No explanation.

{
  "classification": "fixable | infrastructure | pre-existing | retry | abort",
  "reason": "One sentence explaining the failure, QUOTING the exact error code and file path verbatim from the error output (e.g. \\"TS2344 at src/pages/foo.tsx:12\\" or \\"ESLint no-unused-vars at src/utils/bar.ts:5\\"). DO NOT paraphrase or invent error codes — copy literally from the input.",
  "resolution": "Specific instructions referencing the same quoted errors"
}

Classification rules:
- fixable: Error is in a file that was just modified by the build stage. Cite the exact error code and the modified file.
- infrastructure: External dependency not available (database, API, service). Cite the exact error phrase.
- pre-existing: Error is in a file that was NOT modified by the build stage. Cite which file and which error code.
- retry: Transient error (network timeout, rate limit, flaky test). Cite the phrase that indicates transience.
- abort: Unrecoverable (permission denied, corrupted state, out of disk). Cite the phrase.

CRITICAL: your "reason" MUST contain at least one token copied verbatim from the error output — an error code (TS####, ESLint rule name), a file path, or a distinctive error phrase. Responses that paraphrase without quoting will be rejected.

Example good reason: "TS2344 at src/pages/error/ErrorPage.tsx — error is in a file not modified by build (pre-existing)."
Example BAD reason: "Some types need const instead of let" — paraphrased, no literal quote, no file path.

Error context:
`

/**
 * Return true if the LLM's output contains at least one distinctive token
 * copied verbatim from `errorOutput`. Checks both `reason` and `resolution`
 * — the LLM can cite the error in either field.
 *
 * Looks for:
 *   - Compiler error codes (TS2344, TS18047, RS1234)
 *   - Uppercase system error names (ECONNREFUSED, ETIMEDOUT, EACCES, …)
 *   - ESLint-style rule slugs (no-unused-vars, @next/next/…, rules-of-hooks)
 *   - File paths (src/foo.ts, tests/bar.ts, .next/types/validator.ts)
 *
 * Used to reject LLM responses that paraphrase without quoting.
 */
export function hasLiteralQuote(reason: string, errorOutput: string, resolution = ""): boolean {
  if ((!reason && !resolution) || !errorOutput) return false
  const haystack = `${reason}\n${resolution}`

  // 1. Compiler error codes — letters + digits (e.g. TS2344, RS1234)
  const codeRe = /\b[A-Z]{2,}\d{3,}\b/g
  const errorCodes = new Set([...errorOutput.matchAll(codeRe)].map((m) => m[0]))
  for (const code of errorCodes) {
    if (haystack.includes(code)) return true
  }

  // 2. Uppercase system error names (≥4 letters, no digits) — ECONNREFUSED,
  //    ETIMEDOUT, EACCES, ENOSPC, OOM, KILLED, SIGTERM, etc.
  const sysErrRe = /\b[A-Z]{4,}\b/g
  const sysErrs = new Set([...errorOutput.matchAll(sysErrRe)].map((m) => m[0]))
  for (const e of sysErrs) {
    if (haystack.includes(e)) return true
  }

  // 3. ESLint rule names (slashes or hyphens) — e.g. @next/next/no-assign-module-variable
  const ruleRe = /@?[a-z][\w-]*\/[\w/-]+|\b[a-z][\w-]+(?:-[a-z][\w-]+){1,}\b/g
  const rules = new Set([...errorOutput.matchAll(ruleRe)].map((m) => m[0]))
  for (const rule of rules) {
    if (rule.length < 5) continue
    if (haystack.includes(rule)) return true
  }

  // 4. File paths referenced in errorOutput and re-quoted
  const pathRe = /(?:[a-zA-Z_.][\w./-]*\/)?[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|py|rs|go|java)/g
  const paths = new Set([...errorOutput.matchAll(pathRe)].map((m) => m[0]))
  for (const p of paths) {
    if (p.length < 4) continue
    if (haystack.includes(p)) return true
  }

  return false
}

export async function diagnoseFailure(
  stageName: string,
  errorOutput: string,
  modifiedFiles: string[],
  runner: AgentRunner,
  model: string,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<DiagnosisResult> {
  // ─── Primary: cheap heuristic — are all errors in unmodified files? ────────
  // When this fires cleanly, we skip the LLM entirely. This is the load-bearing
  // case (chronic pre-existing errors in a repo) so saving an LLM round-trip +
  // closing the "prompt hallucinates" attack surface is strictly an upgrade.
  const heuristic = classifyByChangeset(errorOutput, modifiedFiles)
  if (heuristic) {
    logger.info(`  Diagnosis (heuristic): ${heuristic.classification} — ${heuristic.reason}`)
    return heuristic
  }

  const context = [
    `Stage: ${stageName}`,
    ``,
    `Error output:`,
    errorOutput.slice(-5000), // Last 5000 chars for accurate diagnosis
    ``,
    modifiedFiles.length > 0
      ? `Files modified by build stage:\n${modifiedFiles.map((f) => `- ${f}`).join("\n")}`
      : "No files were modified (build may not have run yet).",
  ].join("\n")

  const prompt = DIAGNOSIS_PROMPT + context

  try {
    const result = await runner.run(
      "diagnosis",
      prompt,
      model,
      90_000,
      "",
      options,
    )

    if (result.outcome === "completed" && result.output) {
      const cleaned = result.output
        .replace(/^```json\s*\n?/m, "")
        .replace(/\n?```\s*$/m, "")
        .trim()

      const parseResult = parseJsonSafe<{
        classification: string
        reason?: string
        resolution?: string
      }>(cleaned, ["classification"])

      if (parseResult.ok) {
        const { data } = parseResult
        const validClassifications: FailureClassification[] = [
          "fixable", "infrastructure", "pre-existing", "retry", "abort",
        ]

        const reason = data.reason ?? ""
        const resolution = data.resolution ?? ""
        const quoted = hasLiteralQuote(reason, errorOutput, resolution)

        if (!quoted) {
          logger.warn(
            `  Diagnosis LLM did not quote any error verbatim — rejecting response: "${reason.slice(0, 100)}"`,
          )
          // Fall through to retry default
        } else if (validClassifications.includes(data.classification as FailureClassification)) {
          logger.info(`  Diagnosis: ${data.classification} — ${reason}`)
          return {
            classification: data.classification as FailureClassification,
            reason,
            resolution: data.resolution ?? "",
          }
        } else {
          logger.warn(`  Diagnosis returned invalid classification: ${data.classification}`)
        }
      } else {
        logger.warn(`  Diagnosis JSON invalid: ${parseResult.error}`)
      }
    }
  } catch (err) {
    logger.warn(`  Diagnosis error: ${err instanceof Error ? err.message : err}`)
  }

  // Default: "retry" is safer than "fixable" — it re-runs the gate without
  // triggering an autofix agent that could make the situation worse.
  logger.warn("  Diagnosis failed or un-quoted — defaulting to retry")
  return {
    classification: "retry",
    reason: "Could not diagnose failure — retrying gate",
    resolution: errorOutput.slice(-500),
  }
}

/**
 * Heuristic classifier: if we can identify file paths referenced by the
 * error lines and ALL of them are NOT in the changeset, classify as
 * pre-existing. Returns null if the heuristic is inconclusive (no paths,
 * or mixed changeset/non-changeset).
 */
function classifyByChangeset(
  errorOutput: string,
  modifiedFiles: string[],
): DiagnosisResult | null {
  if (modifiedFiles.length === 0) return null

  const errorLines = errorOutput.split("\n").filter((l) =>
    /error|Error|ERROR|failed|Failed|FAIL/i.test(l),
  )
  const errorFilePaths = new Set<string>()
  // Broader regex than the original src/…: accepts tests/, .next/,
  // app/, bare filename, tsx/jsx/mjs/cjs too.
  const pathRe = /(?:[a-zA-Z_.][\w./-]*\/)?[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java)/g
  for (const line of errorLines) {
    for (const m of line.matchAll(pathRe)) {
      const p = m[0]
      if (p.length >= 4) errorFilePaths.add(p)
    }
  }
  if (errorFilePaths.size === 0) return null

  const modifiedSet = new Set(modifiedFiles)
  const errorPathsArr = [...errorFilePaths]
  const allPreExisting = errorPathsArr.every(
    (f) =>
      !modifiedSet.has(f) &&
      !modifiedFiles.some((m) => m === f || m.endsWith(f) || f.endsWith(m)),
  )

  if (allPreExisting) {
    return {
      classification: "pre-existing",
      reason: `All error file paths are not in the changeset: ${errorPathsArr.slice(0, 5).join(", ")}${errorPathsArr.length > 5 ? ", …" : ""}`,
      resolution: `The following files have pre-existing errors not introduced by this task: ${errorPathsArr.join(", ")}`,
    }
  }
  return null
}

/** Does `errorLine` reference `filePath` (exact or suffix/prefix overlap)? */
export function errorReferencesPath(errorLine: string, filePath: string): boolean {
  if (!errorLine || !filePath) return false
  if (errorLine.includes(filePath)) return true
  // Suffix match: file path ends with a sub-path appearing in the error
  const base = filePath.split("/").pop() ?? filePath
  if (base.length >= 4 && errorLine.includes(base)) {
    // Sanity: make sure the match is path-shaped in the error line
    return /[\w./-]*[\w.-]+\.[a-z]+/.test(errorLine)
  }
  return false
}

/** Does `errorLine` reference ANY of the given paths? */
export function errorReferencesAnyOf(errorLine: string, paths: string[]): boolean {
  return paths.some((p) => errorReferencesPath(errorLine, p))
}

export function getModifiedFiles(projectDir: string): string[] {
  try {
    // Staged + unstaged changes (what the build stage actually modified)
    const staged = execFileSync("git", ["diff", "--name-only", "--cached"], {
      encoding: "utf-8",
      cwd: projectDir,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const unstaged = execFileSync("git", ["diff", "--name-only"], {
      encoding: "utf-8",
      cwd: projectDir,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const all = `${staged}\n${unstaged}`.split("\n").filter(Boolean)
    return [...new Set(all)]
  } catch (err) {
    logger.warn(`  Failed to get modified files: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
