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
  _setDataDir as _setActionStateDataDir,
} from "./store/action-state.js";
export {
  logEvent,
  getEventHistory,
  getLastEvent,
  getLastEventOfType,
  countEvents,
  _setDataDir as _setEventLogDataDir,
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
  _setDataDir as _setPrStateDataDir,
  type TaskPRState,
  type PRStatus,
} from "./store/pr-state.js";
export { registry } from "./hooks/registry.js";
export type { Hook, HookResult, HookContext, HookConfig, HookType } from "./hooks/types.js";
