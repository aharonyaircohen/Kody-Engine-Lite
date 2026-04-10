/**
 * @fileOverview Event System — Public API
 * @fileType public-api
 *
 * Re-exports all public types and functions.
 */

export { emitter, emit } from "./events/emitter.js";
export type {
  KodyEvent,
  KodyEventInput,
  EventName,
  EventPayloadMap,
  PipelineStartedPayload,
  PipelineSuccessPayload,
  PipelineFailedPayload,
  ActionCancelledPayload,
  StepStartedPayload,
  StepWaitingPayload,
  StepCompletePayload,
  StepFailedPayload,
  UserResponsePayload,
  TaskPrCreatedPayload,
  TaskPrMergedPayload,
  SessionCompletedPayload,
  TaskSummary,
} from "./events/types.js";
export { isEventName } from "./events/types.js";
export {
  upsertActionState,
  pollInstruction,
  enqueueInstruction,
  getActionState,
  listActionStates,
  deleteActionState,
  isActionStale,
  expireStaleActions,
  type ActionState,
  type ActionStatus,
} from "./store/action-state.js";
export {
  logEvent,
  getEventHistory,
  getLastEvent,
  getLastEventOfType,
  countEvents,
  type EventLogEntry,
} from "./store/event-log.js";
export {
  upsertPRState,
  markPRCreated,
  markPRMerged,
  getPRState,
  getPRStatesBySession,
  getOpenPRsForSession,
  listPRStates,
  type TaskPRState,
  type PRStatus,
} from "./store/pr-state.js";
export { parseDashboardEndpoints, resolveDashboardUrl } from "./config/environments.js";
export type { DashboardEndpoint } from "./config/environments.js";
export { registry } from "./hooks/registry.js";
export type { Hook, HookResult, HookContext, HookConfig, HookType } from "./hooks/types.js";
