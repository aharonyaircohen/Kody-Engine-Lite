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

// ─── Decompose Validation ────────────────────────────────────────────────────

interface DecomposeJson {
  decomposable: boolean
  reason: string
  complexity_score: number
  recommended_subtasks: number
  sub_tasks: Array<{
    id: string
    title: string
    description: string
    scope: string[]
    plan_steps: number[]
    depends_on: string[]
    shared_context: string
  }>
}

/**
 * Detect circular dependencies in a sub-task dependency graph.
 * Uses iterative DFS with explicit visited/stack tracking.
 */
export function hasCyclicDependencies(
  subTasks: Array<{ id: string; depends_on: string[] }>,
): boolean {
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const adj = new Map<string, string[]>()

  for (const st of subTasks) {
    adj.set(st.id, st.depends_on)
  }

  for (const st of subTasks) {
    if (visited.has(st.id)) continue

    // Iterative DFS
    const stack: Array<{ id: string; childIdx: number }> = [{ id: st.id, childIdx: 0 }]
    inStack.add(st.id)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const deps = adj.get(frame.id) ?? []

      if (frame.childIdx >= deps.length) {
        // Done with this node
        inStack.delete(frame.id)
        visited.add(frame.id)
        stack.pop()
        continue
      }

      const child = deps[frame.childIdx]
      frame.childIdx++

      if (inStack.has(child)) return true // cycle found
      if (visited.has(child)) continue

      inStack.add(child)
      stack.push({ id: child, childIdx: 0 })
    }
  }

  return false
}

export function validateDecomposeJson(content: string): ValidationResult {
  let parsed: DecomposeJson
  try {
    parsed = JSON.parse(stripFences(content))
  } catch (err) {
    return { valid: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Required fields
  if (typeof parsed.decomposable !== "boolean") {
    return { valid: false, error: "Missing or invalid field: decomposable" }
  }
  if (typeof parsed.reason !== "string" || !parsed.reason) {
    return { valid: false, error: "Missing or invalid field: reason" }
  }
  if (typeof parsed.complexity_score !== "number" || parsed.complexity_score < 1 || parsed.complexity_score > 10 || !Number.isInteger(parsed.complexity_score)) {
    return { valid: false, error: "complexity_score must be an integer 1-10" }
  }

  // If not decomposable, sub_tasks can be empty
  if (!parsed.decomposable) {
    return { valid: true }
  }

  // Decomposable — validate sub_tasks
  if (!Array.isArray(parsed.sub_tasks)) {
    return { valid: false, error: "sub_tasks must be an array" }
  }
  if (parsed.sub_tasks.length < 2) {
    return { valid: false, error: "Decomposable tasks must have at least 2 sub-tasks" }
  }
  if (parsed.sub_tasks.length > 4) {
    return { valid: false, error: "Maximum 4 sub-tasks allowed" }
  }

  const validIds = new Set(parsed.sub_tasks.map((st) => st.id))
  const allScopes = new Set<string>()
  const allPlanSteps = new Set<number>()

  for (const st of parsed.sub_tasks) {
    if (!st.id || !st.title || !st.description) {
      return { valid: false, error: `Sub-task missing required fields: id, title, or description` }
    }
    if (!Array.isArray(st.scope) || st.scope.length === 0) {
      return { valid: false, error: `Sub-task "${st.id}" must have a non-empty scope array` }
    }
    if (!Array.isArray(st.plan_steps) || st.plan_steps.length === 0) {
      return { valid: false, error: `Sub-task "${st.id}" must have non-empty plan_steps` }
    }

    // Check scope disjointness
    for (const file of st.scope) {
      if (allScopes.has(file)) {
        return { valid: false, error: `File "${file}" appears in multiple sub-tasks` }
      }
      allScopes.add(file)
    }

    // Check plan_steps disjointness
    for (const step of st.plan_steps) {
      if (allPlanSteps.has(step)) {
        return { valid: false, error: `Plan step ${step} assigned to multiple sub-tasks` }
      }
      allPlanSteps.add(step)
    }

    // Validate depends_on references
    if (Array.isArray(st.depends_on)) {
      for (const dep of st.depends_on) {
        if (!validIds.has(dep)) {
          return { valid: false, error: `Sub-task "${st.id}" depends on unknown sub-task "${dep}"` }
        }
        if (dep === st.id) {
          return { valid: false, error: `Sub-task "${st.id}" depends on itself` }
        }
      }
    }
  }

  // Check for circular dependencies
  if (hasCyclicDependencies(parsed.sub_tasks)) {
    return { valid: false, error: "Circular dependency detected among sub-tasks" }
  }

  return { valid: true }
}
