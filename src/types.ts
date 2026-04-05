export type StageName =
  | "taskify"
  | "plan"
  | "build"
  | "verify"
  | "review"
  | "review-fix"
  | "ship"

export type StageType = "agent" | "gate" | "deterministic"

export type PipelineState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"

export interface StageDefinition {
  name: StageName
  type: StageType
  modelTier: "cheap" | "mid" | "strong"
  timeout: number
  maxRetries: number
  outputFile?: string
  retryWithAgent?: string
}

export interface StageState {
  state: PipelineState
  startedAt?: string
  completedAt?: string
  retries: number
  error?: string
  outputFile?: string
  promptTokens?: number
}

export interface PipelineStatus {
  taskId: string
  state: "running" | "completed" | "failed"
  stages: Record<StageName, StageState>
  sessions?: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface StageResult {
  outcome: "completed" | "failed" | "timed_out"
  outputFile?: string
  error?: string
  retries: number
  promptTokens?: number
}

export interface AgentResult {
  outcome: "completed" | "failed" | "timed_out"
  output?: string
  error?: string
}

export interface AgentRunnerOptions {
  cwd?: string
  env?: Record<string, string>
  sessionId?: string
  resumeSession?: boolean
  mcpConfigJson?: string
}

export interface AgentRunner {
  run(
    stageName: string,
    prompt: string,
    model: string,
    timeout: number,
    taskDir: string,
    options?: AgentRunnerOptions,
  ): Promise<AgentResult>
  healthCheck(): Promise<boolean>
}

export interface ResolvedTool {
  name: string
  stages: string[]
  setup: string
  skill?: string // skills.sh package ref, e.g. "microsoft/playwright-cli@playwright-cli"
}

export interface PipelineContext {
  taskId: string
  taskDir: string
  projectDir: string
  runners: Record<string, AgentRunner>
  sessions?: Record<string, string>
  tools?: ResolvedTool[]
  input: {
    mode: "full" | "rerun" | "status"
    fromStage?: string
    dryRun?: boolean
    issueNumber?: number
    prNumber?: number
    prBaseBranch?: string
    feedback?: string
    local?: boolean
    complexity?: "low" | "medium" | "high" | "hotfix"
    skipTests?: boolean
  }
}

// ─── Decompose Types ─────────────────────────────────────────────────────────

export interface SubTaskDefinition {
  id: string              // "part-1", "part-2"
  title: string
  description: string
  scope: string[]         // exclusive file ownership
  plan_steps: number[]    // which plan step numbers this sub-task implements
  depends_on: string[]    // sub-task IDs (empty = independent)
  shared_context: string  // info this sub-task needs from parent context
}

export interface DecomposeOutput {
  decomposable: boolean
  reason: string
  complexity_score: number     // 1-10
  recommended_subtasks: number
  sub_tasks: SubTaskDefinition[]
}

export interface SubPipelineResult {
  subTaskId: string
  outcome: "completed" | "failed"
  branchName: string
  error?: string
}

export interface DecomposeState {
  taskId: string
  state: "running" | "completed" | "failed"
  decompose: DecomposeOutput
  subPipelines: SubPipelineResult[]
  mergeOutcome?: "merged" | "conflict" | "fallback"
  compose?: {
    verify: "completed" | "failed"
    review: "completed" | "failed"
    ship: "completed" | "failed"
  }
}
