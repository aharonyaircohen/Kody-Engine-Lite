/**
 * Security scanning rules — generic patterns for any project.
 */

export type Severity = "critical" | "high" | "medium" | "low"

export interface SecurityFinding {
  rule: string
  severity: Severity
  file: string
  line?: number
  message: string
  detail: string
}

// ============================================================================
// Hardcoded secret patterns
// ============================================================================

export interface SecretPattern {
  label: string
  pattern: RegExp
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { label: "AWS access key", pattern: /['"]AKIA[0-9A-Z]{16}['"]/ },
  { label: "Generic API key assignment", pattern: /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i },
  { label: "Private key block", pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/ },
  { label: "JWT token", pattern: /['"]eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}['"]/ },
]

export const SECRET_SCAN_EXCLUDES: string[] = [
  "node_modules/",
  ".next/",
  ".git/",
  "dist/",
  "build/",
  "tests/",
  "watch/",
  ".env",
  "pnpm-lock.yaml",
  "package-lock.json",
  "*.test.ts",
  "*.spec.ts",
  "*.md",
  "*.json",
]

// ============================================================================
// Unsafe code patterns
// ============================================================================

export interface UnsafePattern {
  label: string
  pattern: RegExp
  severity: Severity
}

export const UNSAFE_PATTERNS: UnsafePattern[] = [
  { label: "eval() usage", pattern: /\beval\s*\(/, severity: "high" },
  { label: "innerHTML assignment", pattern: /\.innerHTML\s*=/, severity: "medium" },
  { label: "Unsanitized exec", pattern: /exec\s*\(\s*`/, severity: "high" },
  { label: "Unsanitized execSync", pattern: /execSync\s*\(\s*`/, severity: "high" },
]

// ============================================================================
// Committed env files
// ============================================================================

export const ENV_FILE_PATTERNS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
]
