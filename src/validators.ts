export interface ValidationResult {
  valid: boolean
  error?: string
}

const REQUIRED_TASK_FIELDS = [
  "task_type",
  "title",
  "description",
  "scope",
  "risk_level",
]

export function stripFences(content: string): string {
  return content.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
}

/**
 * Safely parse JSON with structural validation.
 * Returns `{ ok: true, data }` on success, `{ ok: false, error }` on failure.
 * Pass `requiredFields` to verify keys exist on the parsed object.
 */
export function parseJsonSafe<T = unknown>(
  raw: string,
  requiredFields?: string[],
): { ok: true; data: T } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `Expected JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}` }
  }
  if (requiredFields) {
    for (const field of requiredFields) {
      if (!(field in parsed)) {
        return { ok: false, error: `Missing required field: ${field}` }
      }
    }
  }
  return { ok: true, data: parsed as T }
}

export function validateTaskJson(content: string): ValidationResult {
  try {
    const parsed = JSON.parse(stripFences(content))
    for (const field of REQUIRED_TASK_FIELDS) {
      if (!(field in parsed)) {
        return { valid: false, error: `Missing field: ${field}` }
      }
    }
    return { valid: true }
  } catch (err) {
    return {
      valid: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export function validatePlanMd(content: string): ValidationResult {
  if (content.length < 10) {
    return { valid: false, error: "Plan is too short (< 10 chars)" }
  }
  if (!/^##\s+\w+/m.test(content)) {
    return { valid: false, error: "Plan has no markdown h2 sections" }
  }
  return { valid: true }
}

export function validateReviewMd(content: string): ValidationResult {
  if (/pass/i.test(content) || /fail/i.test(content)) {
    return { valid: true }
  }
  return { valid: false, error: "Review must contain 'pass' or 'fail'" }
}
