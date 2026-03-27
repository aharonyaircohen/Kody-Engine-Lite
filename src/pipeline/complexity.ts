import type { StageDefinition } from "../types.js"

const COMPLEXITY_SKIP: Record<string, string[]> = {
  low: ["plan", "review", "review-fix"],
  medium: ["review-fix"],
  high: [],
}

export function filterByComplexity(
  stages: StageDefinition[],
  complexity: string,
): StageDefinition[] {
  const skip = COMPLEXITY_SKIP[complexity] ?? []
  return stages.filter((s) => !skip.includes(s.name))
}

export function isValidComplexity(value: string): boolean {
  return value in COMPLEXITY_SKIP
}
