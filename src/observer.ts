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

const DIAGNOSIS_PROMPT = `You are a pipeline failure diagnosis agent. Analyze the error and classify it.

Output ONLY valid JSON. No markdown fences. No explanation.

{
  "classification": "fixable | infrastructure | pre-existing | retry | abort",
  "reason": "One sentence explaining what went wrong",
  "resolution": "Specific instructions for fixing (if fixable) or what the user needs to do (if infrastructure)"
}

Classification rules:
- fixable: Error is in code that was just written/modified. The resolution should describe exactly what to change.
- infrastructure: External dependency not available (database, API, service). The resolution should say what the user needs to set up.
- pre-existing: Error exists in code that was NOT modified. Safe to skip. The resolution should note which files.
- retry: Transient error (network timeout, rate limit, flaky test). Worth retrying once.
- abort: Unrecoverable error (permission denied, corrupted state, out of disk). Pipeline should stop.

Error context:
`

export async function diagnoseFailure(
  stageName: string,
  errorOutput: string,
  modifiedFiles: string[],
  runner: AgentRunner,
  model: string,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<DiagnosisResult> {
  const context = [
    `Stage: ${stageName}`,
    ``,
    `Error output:`,
    errorOutput.slice(-5000), // Last 5000 chars of error for accurate diagnosis
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
      90_000, // 90s timeout — MiniMax can be slow to respond
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

        if (validClassifications.includes(data.classification as FailureClassification)) {
          logger.info(`  Diagnosis: ${data.classification} — ${data.reason}`)
          return {
            classification: data.classification as FailureClassification,
            reason: data.reason ?? "Unknown reason",
            resolution: data.resolution ?? "",
          }
        }
        logger.warn(`  Diagnosis returned invalid classification: ${data.classification}`)
      } else {
        logger.warn(`  Diagnosis JSON invalid: ${parseResult.error}`)
      }
    }
  } catch (err) {
    logger.warn(`  Diagnosis error: ${err instanceof Error ? err.message : err}`)
  }

  // Heuristic fallback: if we have modified files and ALL errors reference files
  // that were NOT modified by the build stage, classify as pre-existing.
  if (modifiedFiles.length > 0) {
    const errorLines = errorOutput.split("\n").filter((l) =>
      /error|Error|ERROR|failed|Failed|FAIL/i.test(l)
    )
    // Extract file paths mentioned in error lines
    const errorFilePaths = errorLines.flatMap((line) => {
      const matches = line.match(/src\/[^\s(:]+\.[a-z]+/g)
      return matches ?? []
    })
    if (errorFilePaths.length > 0) {
      const modifiedSet = new Set(modifiedFiles)
      const allPreExisting = errorFilePaths.every(
        (f) => !modifiedSet.has(f) && !modifiedFiles.some((m) => m.endsWith(f))
      )
      if (allPreExisting) {
        logger.warn("  Diagnosis fallback: all errors in unmodified files → pre-existing")
        return {
          classification: "pre-existing",
          reason: "All errors are in files not modified by the build stage",
          resolution: `The following files have pre-existing errors not introduced by this task: ${[...new Set(errorFilePaths)].join(", ")}`,
        }
      }
    }
  }

  // Default: "retry" is safer than "fixable" — it re-runs the gate without
  // triggering an autofix agent that could make the situation worse on
  // infrastructure or pre-existing issues. The verify loop's max-attempts
  // cap prevents infinite retries.
  logger.warn("  Diagnosis failed — defaulting to retry")
  return {
    classification: "retry",
    reason: "Could not diagnose failure — retrying gate",
    resolution: errorOutput.slice(-500),
  }
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
