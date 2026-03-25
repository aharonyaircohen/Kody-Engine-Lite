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

export function validateTaskJson(content: string): ValidationResult {
  try {
    const parsed = JSON.parse(content)
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
