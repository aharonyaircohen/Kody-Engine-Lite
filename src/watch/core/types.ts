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
  /** Issue number for posting digest reports */
  digestIssue?: number
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
  getOpenIssues(labels?: string[]): IssueInfo[]
  createIssue(title: string, body: string, labels: string[]): number | null
  searchIssues(query: string): IssueInfo[]
}

export interface IssueInfo {
  number: number
  title: string
  labels: string[]
  updatedAt: string
}

// ============================================================================
// Config & Result
// ============================================================================

export interface WatchConfig {
  repo: string
  dryRun: boolean
  stateFile: string
  plugins: WatchPlugin[]
  digestIssue?: number
}

export interface WatchResult {
  cycleNumber: number
  pluginsRun: number
  actionsProduced: number
  actionsExecuted: number
  actionsDeduplicated: number
  errors: string[]
}
