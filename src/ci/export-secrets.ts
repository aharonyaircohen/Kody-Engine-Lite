/**
 * Exports secrets from GitHub Actions as heredocs to GITHUB_ENV.
 *
 * GitHub Actions secrets are passed as JSON via the `ALL_SECRETS` env var.
 * This tool reads that JSON, filters out GITHUB_TOKEN, and writes each secret
 * to $GITHUB_ENV as a heredoc so Actions sets the env var for subsequent steps.
 *
 * Usage: kody-engine ci-export-secrets
 * Env:   ALL_SECRETS  — JSON object of all repo secrets (from `toJSON(secrets)`)
 *        GITHUB_ENV   — path to .env file (set by Actions)
 */

import * as fs from "fs"

const EXCLUDED_KEYS = new Set(["GITHUB_TOKEN"])

/**
 * Pure: converts a secrets record into heredoc lines for GITHUB_ENV.
 * Returns the string to append to $GITHUB_ENV.
 */
export function secretsToEnvHeredocs(secrets: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(secrets)) {
    if (EXCLUDED_KEYS.has(key)) continue
    const delim = `KODY_EOF_${key}`
    lines.push(`${key}<<${delim}`)
    lines.push(value)
    lines.push(delim)
  }
  return lines.join("\n") + "\n"
}

/**
 * Reads ALL_SECRETS from env, writes heredocs to GITHUB_ENV.
 */
export function runExportSecrets(): void {
  const allSecretsRaw = process.env.ALL_SECRETS
  if (!allSecretsRaw) {
    console.error("ALL_SECRETS env var is not set")
    process.exit(1)
  }

  let secrets: Record<string, string>
  try {
    secrets = JSON.parse(allSecretsRaw)
  } catch {
    console.error("Failed to parse ALL_SECRETS as JSON")
    process.exit(1)
  }

  const heredocs = secretsToEnvHeredocs(secrets)

  const envPath = process.env.GITHUB_ENV
  if (envPath) {
    fs.appendFileSync(envPath, heredocs)
    const count = Object.keys(secrets).filter((k) => !EXCLUDED_KEYS.has(k)).length
    console.log(`Exported ${count} secrets to ${envPath}`)
  } else {
    // Outside Actions: print to stdout for debugging
    console.log(heredocs)
  }
}
