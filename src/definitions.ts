import type { StageDefinition } from "./types.js"

export const STAGES: StageDefinition[] = [
  {
    name: "taskify",
    type: "agent",
    modelTier: "cheap",
    timeout: 600_000,
    maxRetries: 1,
    outputFile: "task.json",
  },
  {
    name: "plan",
    type: "agent",
    modelTier: "strong",
    timeout: 600_000,
    maxRetries: 1,
    outputFile: "plan.md",
  },
  {
    name: "build",
    type: "agent",
    modelTier: "mid",
    timeout: 2_400_000,
    maxRetries: 1,
  },
  {
    name: "verify",
    type: "gate",
    modelTier: "cheap",
    timeout: 300_000,
    maxRetries: 2,
    retryWithAgent: "autofix",
  },
  {
    name: "review",
    type: "agent",
    modelTier: "strong",
    timeout: 600_000,
    maxRetries: 1,
    outputFile: "review.md",
  },
  {
    name: "review-fix",
    type: "agent",
    modelTier: "mid",
    timeout: 1_200_000,
    maxRetries: 1,
  },
  {
    name: "ship",
    type: "deterministic",
    modelTier: "cheap",
    timeout: 240_000,
    maxRetries: 1,
    outputFile: "ship.md",
  },
]

export function getStage(name: string): StageDefinition | undefined {
  return STAGES.find((s) => s.name === name)
}

/** Apply per-stage timeout overrides from kody.config.json (values in seconds) */
export function applyTimeoutOverrides(overrides: Record<string, number>): void {
  for (const stage of STAGES) {
    if (overrides[stage.name] != null) {
      stage.timeout = overrides[stage.name] * 1000
    }
  }
}
