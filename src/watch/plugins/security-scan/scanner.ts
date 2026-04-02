/**
 * Core scanning engine — deterministic pattern matching, no LLM.
 */

import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import type { SecurityFinding, Severity } from "./rules.js"
import { SECRET_PATTERNS, SECRET_SCAN_EXCLUDES, UNSAFE_PATTERNS, ENV_FILE_PATTERNS } from "./rules.js"

// ============================================================================
// Helper: Recursive file discovery
// ============================================================================

function findFiles(dir: string, pattern: RegExp, exclude: string[] = []): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results

  let entries: fs.Dirent[] | undefined
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  if (!entries || !Array.isArray(entries)) return results

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    const shouldExclude = exclude.some((ex) => {
      if (ex.endsWith("/")) return fullPath.includes(ex)
      if (ex.startsWith("*")) return entry.name.endsWith(ex.slice(1))
      return entry.name === ex || fullPath.endsWith(ex)
    })
    if (shouldExclude) continue

    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, pattern, exclude))
    } else if (pattern.test(entry.name)) {
      results.push(fullPath)
    }
  }

  return results
}

// ============================================================================
// Scan 1: Hardcoded secrets
// ============================================================================

export function scanForHardcodedSecrets(rootDir: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const srcDir = path.join(rootDir, "src")
  if (!fs.existsSync(srcDir)) return findings

  const sourceFiles = findFiles(srcDir, /\.(ts|tsx|js|jsx)$/, SECRET_SCAN_EXCLUDES)

  for (const filePath of sourceFiles) {
    const relativePath = path.relative(rootDir, filePath)
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const secretDef of SECRET_PATTERNS) {
        if (secretDef.pattern.test(line)) {
          findings.push({
            rule: "hardcoded-secret",
            severity: "critical",
            file: relativePath,
            line: i + 1,
            message: `Potential hardcoded secret: ${secretDef.label}`,
            detail: `Line ${i + 1}: ${line.trim().substring(0, 80)}...`,
          })
        }
      }
    }
  }

  return findings
}

// ============================================================================
// Scan 2: Unsafe code patterns
// ============================================================================

export function scanForUnsafePatterns(rootDir: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const srcDir = path.join(rootDir, "src")
  if (!fs.existsSync(srcDir)) return findings

  const sourceFiles = findFiles(srcDir, /\.(ts|tsx|js|jsx)$/, SECRET_SCAN_EXCLUDES)

  for (const filePath of sourceFiles) {
    const relativePath = path.relative(rootDir, filePath)
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const unsafeDef of UNSAFE_PATTERNS) {
        if (unsafeDef.pattern.test(line)) {
          findings.push({
            rule: `unsafe-pattern:${unsafeDef.label.toLowerCase().replace(/\s+/g, "-")}`,
            severity: unsafeDef.severity,
            file: relativePath,
            line: i + 1,
            message: `Unsafe pattern: ${unsafeDef.label}`,
            detail: `Line ${i + 1}: ${line.trim().substring(0, 80)}`,
          })
        }
      }
    }
  }

  return findings
}

// ============================================================================
// Scan 3: Committed .env files
// ============================================================================

export function scanForCommittedEnvFiles(rootDir: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const envFile of ENV_FILE_PATTERNS) {
    const envPath = path.join(rootDir, envFile)
    if (!fs.existsSync(envPath)) continue

    // Check if tracked by git
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", envFile], {
        cwd: rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      // If we get here, the file IS tracked
      findings.push({
        rule: "committed-env-file",
        severity: "critical",
        file: envFile,
        message: `Environment file committed to git: ${envFile}`,
        detail: `${envFile} is tracked by git and may contain secrets`,
      })
    } catch {
      // Not tracked — this is fine
    }
  }

  return findings
}

// ============================================================================
// Scan 4: Dependency vulnerabilities
// ============================================================================

export function scanDependencyVulnerabilities(rootDir: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  // Detect package manager
  const hasYarn = fs.existsSync(path.join(rootDir, "yarn.lock"))
  const hasPnpm = fs.existsSync(path.join(rootDir, "pnpm-lock.yaml"))
  const hasNpm = fs.existsSync(path.join(rootDir, "package-lock.json"))

  const auditCmd = hasPnpm ? "pnpm" : hasYarn ? "yarn" : hasNpm ? "npm" : null
  if (!auditCmd) return findings

  try {
    const output = execFileSync(auditCmd, ["audit", "--json"], {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Parse audit output — format varies by package manager
    if (hasPnpm || hasNpm) {
      // npm/pnpm JSON format
      try {
        const audit = JSON.parse(output)
        const vulnerabilities = audit.vulnerabilities || audit.advisories || {}
        for (const [name, vuln] of Object.entries(vulnerabilities)) {
          const v = vuln as Record<string, unknown>
          const severity = (v.severity as string) || "medium"
          if (severity === "low" || severity === "info") continue

          findings.push({
            rule: "dependency-vulnerability",
            severity: severity === "critical" ? "critical" : severity === "high" ? "high" : "medium",
            file: "package.json",
            message: `Vulnerable dependency: ${name} (${severity})`,
            detail: (v.title as string) || (v.overview as string) || `${name} has a ${severity} vulnerability`,
          })
        }
      } catch {
        // Audit output wasn't valid JSON — common with pnpm
      }
    }
  } catch (error) {
    // Audit command failed — this often means vulnerabilities exist
    const stderr = error instanceof Error ? (error as NodeJS.ErrnoException & { stdout?: string }).stdout || "" : ""
    if (stderr) {
      try {
        const audit = JSON.parse(stderr)
        const meta = audit.metadata || {}
        const total = (meta.vulnerabilities?.critical || 0) + (meta.vulnerabilities?.high || 0)
        if (total > 0) {
          findings.push({
            rule: "dependency-vulnerability",
            severity: "high",
            file: "package.json",
            message: `${total} critical/high dependency vulnerabilities found`,
            detail: `Run '${auditCmd} audit' for details`,
          })
        }
      } catch {
        // Can't parse, skip
      }
    }
  }

  return findings
}

// ============================================================================
// Combined scan
// ============================================================================

export function runAllScans(rootDir: string): SecurityFinding[] {
  const allFindings: SecurityFinding[] = []

  allFindings.push(...scanForHardcodedSecrets(rootDir))
  allFindings.push(...scanForUnsafePatterns(rootDir))
  allFindings.push(...scanForCommittedEnvFiles(rootDir))
  allFindings.push(...scanDependencyVulnerabilities(rootDir))

  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  }

  allFindings.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))

  return allFindings
}
