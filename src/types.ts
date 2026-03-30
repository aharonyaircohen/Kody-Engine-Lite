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

export interface PipelineContext {
  taskId: string
  taskDir: string
  projectDir: string
  runners: Record<string, AgentRunner>
  sessions?: Record<string, string>
  input: {
    mode: "full" | "rerun" | "status"
    fromStage?: string
    dryRun?: boolean
    issueNumber?: number
    prNumber?: number
    feedback?: string
    local?: boolean
    complexity?: "low" | "medium" | "high"
  }
}
