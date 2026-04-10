/**
 * @fileOverview Event System — Event Types
 * @fileType type-definitions
 *
 * No external runtime dependencies — pure TypeScript types.
 */

export type EventName =
  | "pipeline.started"
  | "pipeline.success"
  | "pipeline.failed"
  | "action.cancelled"
  | "step.started"
  | "step.waiting"
  | "step.complete"
  | "step.failed"
  | "user.response"
  | "task.pr.created"
  | "task.pr.merged"
  | "session.completed";

// ─── Payloads ────────────────────────────────────────────────────────────────

export interface PipelineStartedPayload {
  runId: string;
  pipeline?: string;
  sessionId?: string;
  issueNumber?: number;
}

export interface PipelineSuccessPayload {
  runId: string;
  issueNumber?: number;
}

export interface PipelineFailedPayload {
  runId: string;
  error?: string;
  issueNumber?: number;
}

export interface ActionCancelledPayload {
  runId: string;
  cancelledBy?: string;
}

export interface StepStartedPayload {
  runId: string;
  step: string;
}

export interface StepWaitingPayload {
  runId: string;
  step: string;
  context?: Record<string, unknown>;
}

export interface StepCompletePayload {
  runId: string;
  step: string;
  result?: Record<string, unknown>;
}

export interface StepFailedPayload {
  runId: string;
  step: string;
  error?: string;
}

export interface UserResponsePayload {
  runId: string;
  actionId: string;
  instruction: string;
}

export interface TaskPrCreatedPayload {
  runId: string;
  taskId?: string;
  sessionId?: string;
  prNumber: number;
  prUrl: string;
  title: string;
  body?: string;
}

export interface TaskPrMergedPayload {
  runId: string;
  taskId?: string;
  prNumber: number;
}

export interface TaskSummary {
  taskId: string;
  title: string;
  status: "merged" | "open" | "pending" | "failed";
  prNumber?: number;
  prUrl?: string;
}

export interface SessionCompletedPayload {
  runId: string;
  sessionId: string;
  tasks?: TaskSummary[];
}

// ─── Union Payload Map ───────────────────────────────────────────────────────

export type EventPayload =
  | PipelineStartedPayload
  | PipelineSuccessPayload
  | PipelineFailedPayload
  | ActionCancelledPayload
  | StepStartedPayload
  | StepWaitingPayload
  | StepCompletePayload
  | StepFailedPayload
  | UserResponsePayload
  | TaskPrCreatedPayload
  | TaskPrMergedPayload
  | SessionCompletedPayload;

// ─── KodyEvent ───────────────────────────────────────────────────────────────

export interface KodyEvent<N extends EventName = EventName> {
  name: N;
  payload: EventPayload;
  emittedAt: Date;
}

export type KodyEventInput = Omit<KodyEvent, "emittedAt">;

/** Map of event name → payload type (for typed emit helpers) */
export interface EventPayloadMap {
  "pipeline.started": PipelineStartedPayload;
  "pipeline.success": PipelineSuccessPayload;
  "pipeline.failed": PipelineFailedPayload;
  "action.cancelled": ActionCancelledPayload;
  "step.started": StepStartedPayload;
  "step.waiting": StepWaitingPayload;
  "step.complete": StepCompletePayload;
  "step.failed": StepFailedPayload;
  "user.response": UserResponsePayload;
  "task.pr.created": TaskPrCreatedPayload;
  "task.pr.merged": TaskPrMergedPayload;
  "session.completed": SessionCompletedPayload;
}

/** Type-safe emit helper */
export function isEventName(name: string): name is EventName {
  return [
    "pipeline.started",
    "pipeline.success",
    "pipeline.failed",
    "action.cancelled",
    "step.started",
    "step.waiting",
    "step.complete",
    "step.failed",
    "user.response",
    "task.pr.created",
    "task.pr.merged",
    "session.completed",
  ].includes(name);
}
