import { execFileSync } from "child_process"
import { logger } from "./logger.js"
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
): Promise<DiagnosisResult> {
  const context = [
    `Stage: ${stageName}`,
    ``,
    `Error output:`,
    errorOutput.slice(-2000), // Last 2000 chars of error
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
      30_000, // 30s timeout — this should be fast
      "",
    )

    if (result.outcome === "completed" && result.output) {
      const cleaned = result.output
        .replace(/^```json\s*\n?/m, "")
        .replace(/\n?```\s*$/m, "")
        .trim()

      const parsed = JSON.parse(cleaned)

      const validClassifications: FailureClassification[] = [
        "fixable", "infrastructure", "pre-existing", "retry", "abort",
      ]

      if (validClassifications.includes(parsed.classification)) {
        logger.info(`  Diagnosis: ${parsed.classification} — ${parsed.reason}`)
        return {
          classification: parsed.classification,
          reason: parsed.reason ?? "Unknown reason",
          resolution: parsed.resolution ?? "",
        }
      }
    }
  } catch (err) {
    logger.warn(`  Diagnosis error: ${err instanceof Error ? err.message : err}`)
  }

  // Default: assume fixable (safest — will attempt autofix)
  logger.warn("  Diagnosis failed — defaulting to fixable")
  return {
    classification: "fixable",
    reason: "Could not diagnose failure",
    resolution: errorOutput.slice(-500),
  }
}

export function getModifiedFiles(projectDir: string): string[] {
  try {
    const output = execFileSync("git", ["diff", "--name-only", "HEAD~1"], {
      encoding: "utf-8",
      cwd: projectDir,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return output ? output.split("\n").filter(Boolean) : []
  } catch {
    return []
  }
}
