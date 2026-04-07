/**
 * Domain-agnostic types for the Kody Watch framework.
 * Ported from A-Guy inspector — no Kody pipeline knowledge in core types.
 */

// ============================================================================
// Core Types
// ============================================================================

export type Urgency = "critical" | "warning" | "info" | "silent"

export interface WatchPlugin {
  name: string
  description: string
  domain: string
  schedule?: PluginSchedule
  run(ctx: WatchContext): Promise<ActionRequest[]>
}

export interface PluginSchedule {
  /** Run every N cycles (default: 1 = every cycle) */
  every?: number
}

export interface ActionRequest {
  plugin: string
  type: string
  target?: string
  urgency: Urgency
  title: string
  detail: string
  /** Key for deduplication. If set, prevents duplicate actions within dedupWindowMinutes */
  dedupKey?: string
  /** Window for deduplication in minutes. Default: 60 */
  dedupWindowMinutes?: number
  /** Execute the action */
  execute: (ctx: WatchContext) => Promise<ActionResult>
}

export interface ActionResult {
  success: boolean
  message?: string
}

export interface WatchContext {
  repo: string
  dryRun: boolean
  state: StateStore
  github: GitHubClient
  log: Logger
  runTimestamp: string
  cycleNumber: number
  /** Issue number for posting activity log reports */
  activityLog?: number
}

export interface StateStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  save(): void
}

export interface Logger {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export interface GitHubClient {
  postComment(issueNumber: number, body: string): void
  getIssue(issueNumber: number): { body: string | null; title: string | null }
  getIssueComments(issueNumber: number): IssueComment[]
  updateComment(commentId: number, body: string): void
  getOpenIssues(labels?: string[]): IssueInfo[]
  createIssue(title: string, body: string, labels: string[]): number | null
  searchIssues(query: string): IssueInfo[]
}

export interface IssueComment {
  id: number
  body: string
}

export interface IssueInfo {
  number: number
  title: string
  labels: string[]
  updatedAt: string
}

// ============================================================================
// Watch Agents — LLM-powered autonomous agents loaded from .kody/watch/agents/
// ============================================================================

export interface WatchAgentSchedule {
  /** Run every N cycles (default: 1 = every cycle) */
  every: number
}

export interface WatchAgentConfig {
  name: string
  description: string
  schedule: WatchAgentSchedule
  reportOnFailure?: boolean
  /** Agent timeout in milliseconds. Default: 20 minutes */
  timeoutMs?: number
}

export interface WatchAgentDefinition {
  config: WatchAgentConfig
  /** System prompt content from agent.md */
  systemPrompt: string
  /** Absolute path to the agent folder */
  dirPath: string
}

export interface WatchAgentRunResult {
  agentName: string
  outcome: "completed" | "failed" | "timed_out"
  output?: string
  error?: string
}

// ============================================================================
// Config & Result
// ============================================================================

export interface WatchConfig {
  repo: string
  dryRun: boolean
  stateFile: string
  plugins: WatchPlugin[]
  activityLog?: number
  /** LLM-powered watch agents loaded from .kody/watch/agents/ */
  agents: WatchAgentDefinition[]
  /** Model for watch agents (e.g. "claude-sonnet-4-6"). Falls back to agent.modelMap.cheap */
  model: string
  /** LLM provider (e.g. "claude", "minimax"). When non-claude, routes through LiteLLM proxy */
  provider?: string
  /** Absolute path to the project directory */
  projectDir: string
}

export interface WatchResult {
  cycleNumber: number
  pluginsRun: number
  actionsProduced: number
  actionsExecuted: number
  actionsDeduplicated: number
  agentsRun: number
  agentResults: WatchAgentRunResult[]
  errors: string[]
}
