import type { StageDefinition } from "./types.js"

// Default budget/turn limits per stage
export const DEFAULT_BUDGETS: Record<string, { maxTurns: number; maxBudgetUsd: number }> = {
  taskify:     { maxTurns: 20,  maxBudgetUsd: 0.50 },
  plan:        { maxTurns: 30,  maxBudgetUsd: 1.00 },
  build:       { maxTurns: 100, maxBudgetUsd: 5.00 },
  verify:      { maxTurns: 20,  maxBudgetUsd: 0.50 },
  review:      { maxTurns: 30,  maxBudgetUsd: 1.00 },
  "review-fix": { maxTurns: 60,  maxBudgetUsd: 3.00 },
  ship:        { maxTurns: 20,  maxBudgetUsd: 0.50 },
}

// Allowed tools per stage (SDK uses permissionMode: 'plan' when provided)
export const ALLOWED_TOOLS_PER_STAGE: Record<string, string[]> = {
  taskify:     ["Read", "Grep", "Glob"],
  plan:        ["Read", "Grep", "Glob"],
  build:       ["Bash", "Edit", "Read", "Write", "Glob", "Grep", "Agent"],
  verify:      ["Bash", "Read", "Grep", "Glob"],
  review:      ["Read", "Grep", "Glob"],
  "review-fix": ["Bash", "Edit", "Read", "Write", "Glob", "Grep", "Agent"],
  ship:        ["Bash", "Read", "Grep", "Glob"],
}

// Output format schemas for stages that use structured output
export const STAGE_OUTPUT_FORMAT: Record<string, unknown> = {
  taskify: {
    json_schema: {
      name: "taskify_output",
      schema: {
        type: "object",
        properties: {
          task_type: { type: "string", enum: ["feature", "bugfix", "refactor", "docs", "chore"] },
          title: { type: "string", maxLength: 72 },
          description: { type: "string" },
          scope: { type: "array", items: { type: "string" } },
          risk_level: { type: "string", enum: ["low", "medium", "high"] },
          hasUI: { type: "boolean" },
          questions: { type: "array", items: { type: "string" } },
        },
        required: ["task_type", "title", "description", "scope", "risk_level", "hasUI", "questions"],
      },
    },
  },
  review: {
    json_schema: {
      name: "review_verdict",
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["PASS", "FAIL"] },
          reason: { type: "string" },
        },
        required: ["verdict", "reason"],
      },
    },
  },
}

export let STAGES: StageDefinition[] = [
  {
    name: "taskify",
    type: "agent",
    modelTier: "cheap",
    timeout: 600_000,
    maxRetries: 1,
    outputFile: "task.json",
    maxTurns: DEFAULT_BUDGETS.taskify.maxTurns,
    maxBudgetUsd: DEFAULT_BUDGETS.taskify.maxBudgetUsd,
    allowedTools: ALLOWED_TOOLS_PER_STAGE.taskify,
    outputFormat: STAGE_OUTPUT_FORMAT.taskify,
  },
  {
    name: "plan",
    type: "agent",
    modelTier: "strong",
    timeout: 600_000,
    maxRetries: 1,
    outputFile: "plan.md",
    maxTurns: DEFAULT_BUDGETS.plan.maxTurns,
    maxBudgetUsd: DEFAULT_BUDGETS.plan.maxBudgetUsd,
    allowedTools: ALLOWED_TOOLS_PER_STAGE.plan,
  },
  {
    name: "build",
    type: "agent",
    modelTier: "mid",
    timeout: 2_400_000,
    maxRetries: 1,
    maxTurns: DEFAULT_BUDGETS.build.maxTurns,
    maxBudgetUsd: DEFAULT_BUDGETS.build.maxBudgetUsd,
    allowedTools: ALLOWED_TOOLS_PER_STAGE.build,
  },
  {
    name: "verify",
    type: "gate",
    modelTier: "cheap",
    timeout: 300_000,
    maxRetries: 2,
    retryWithAgent: "autofix",
    maxTurns: DEFAULT_BUDGETS.verify.maxTurns,
    maxBudgetUsd: DEFAULT_BUDGETS.verify.maxBudgetUsd,
    allowedTools: ALLOWED_TOOLS_PER_STAGE.verify,
  },
  {
    name: "review",
    type: "agent",
    modelTier: "strong",
    timeout: 600_000,
    maxRetries: 1,
    outputFile: "review.md",
    maxTurns: DEFAULT_BUDGETS.review.maxTurns,
    maxBudgetUsd: DEFAULT_BUDGETS.review.maxBudgetUsd,
    allowedTools: ALLOWED_TOOLS_PER_STAGE.review,
    outputFormat: STAGE_OUTPUT_FORMAT.review,
  },
  {
    name: "review-fix",
    type: "agent",
    modelTier: "mid",
    timeout: 1_200_000,
    maxRetries: 1,
    maxTurns: DEFAULT_BUDGETS["review-fix"].maxTurns,
    maxBudgetUsd: DEFAULT_BUDGETS["review-fix"].maxBudgetUsd,
    allowedTools: ALLOWED_TOOLS_PER_STAGE["review-fix"],
  },
  {
    name: "ship",
    type: "deterministic",
    modelTier: "cheap",
    timeout: 240_000,
    maxRetries: 1,
    outputFile: "ship.md",
    maxTurns: DEFAULT_BUDGETS.ship.maxTurns,
    maxBudgetUsd: DEFAULT_BUDGETS.ship.maxBudgetUsd,
    allowedTools: ALLOWED_TOOLS_PER_STAGE.ship,
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

/** Apply per-stage budget/turn limit overrides from kody.config.json */
export function applyBudgetOverrides(overrides: Record<string, { maxTurns?: number; maxBudgetUsd?: number }>): void {
  for (const stage of STAGES) {
    const o = overrides[stage.name]
    if (o) {
      if (o.maxTurns != null) stage.maxTurns = o.maxTurns
      if (o.maxBudgetUsd != null) stage.maxBudgetUsd = o.maxBudgetUsd
    }
  }
}

// Default values for reset — mirrors the initial STAGES[] values above
const STAGE_DEFAULTS: StageDefinition[] = [
  { name: "taskify",     type: "agent",        modelTier: "cheap",  timeout: 600_000,  maxRetries: 1, outputFile: "task.json",  maxTurns: DEFAULT_BUDGETS.taskify.maxTurns,     maxBudgetUsd: DEFAULT_BUDGETS.taskify.maxBudgetUsd,     allowedTools: ALLOWED_TOOLS_PER_STAGE.taskify,     outputFormat: STAGE_OUTPUT_FORMAT.taskify },
  { name: "plan",        type: "agent",        modelTier: "strong", timeout: 600_000,  maxRetries: 1, outputFile: "plan.md",    maxTurns: DEFAULT_BUDGETS.plan.maxTurns,        maxBudgetUsd: DEFAULT_BUDGETS.plan.maxBudgetUsd,        allowedTools: ALLOWED_TOOLS_PER_STAGE.plan },
  { name: "build",       type: "agent",        modelTier: "mid",    timeout: 2_400_000, maxRetries: 1, maxTurns: DEFAULT_BUDGETS.build.maxTurns,       maxBudgetUsd: DEFAULT_BUDGETS.build.maxBudgetUsd,       allowedTools: ALLOWED_TOOLS_PER_STAGE.build },
  { name: "verify",      type: "gate",         modelTier: "cheap",  timeout: 300_000,  maxRetries: 2, retryWithAgent: "autofix", maxTurns: DEFAULT_BUDGETS.verify.maxTurns,      maxBudgetUsd: DEFAULT_BUDGETS.verify.maxBudgetUsd,      allowedTools: ALLOWED_TOOLS_PER_STAGE.verify },
  { name: "review",      type: "agent",        modelTier: "strong", timeout: 600_000,  maxRetries: 1, outputFile: "review.md", maxTurns: DEFAULT_BUDGETS.review.maxTurns,      maxBudgetUsd: DEFAULT_BUDGETS.review.maxBudgetUsd,      allowedTools: ALLOWED_TOOLS_PER_STAGE.review,      outputFormat: STAGE_OUTPUT_FORMAT.review },
  { name: "review-fix",  type: "agent",        modelTier: "mid",    timeout: 1_200_000, maxRetries: 1, maxTurns: DEFAULT_BUDGETS["review-fix"].maxTurns, maxBudgetUsd: DEFAULT_BUDGETS["review-fix"].maxBudgetUsd, allowedTools: ALLOWED_TOOLS_PER_STAGE["review-fix"] },
  { name: "ship",       type: "deterministic", modelTier: "cheap",  timeout: 240_000,  maxRetries: 1, outputFile: "ship.md",   maxTurns: DEFAULT_BUDGETS.ship.maxTurns,       maxBudgetUsd: DEFAULT_BUDGETS.ship.maxBudgetUsd,       allowedTools: ALLOWED_TOOLS_PER_STAGE.ship },
]

/**
 * Reset STAGES to default values. Call this in test beforeEach to ensure
 * each test starts with a clean slate (avoids mutation leaking between tests).
 */
export function resetStageDefinitions(): void {
  for (let i = 0; i < STAGES.length; i++) {
    const def = STAGE_DEFAULTS[i]
    const stage = STAGES[i]
    stage.timeout = def.timeout
    stage.maxTurns = def.maxTurns
    stage.maxBudgetUsd = def.maxBudgetUsd
    stage.allowedTools = def.allowedTools
    stage.outputFormat = def.outputFormat
    stage.retryWithAgent = def.retryWithAgent
  }
}
