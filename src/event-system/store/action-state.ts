/**
 * @fileOverview Event System — Action State Store
 * @fileType store
 *
 * File-based in-memory store for action polling state.
 * Persisted to .kody-engine/action-state.json in project root.
 */

import * as fs from "fs";
import * as path from "path";

export type ActionStatus = "running" | "waiting" | "complete" | "cancelled";

export interface ActionState {
  runId: string;
  actionId: string;
  sessionId?: string;
  taskId?: string;
  status: ActionStatus;
  step: string;
  instructions: string[];
  cancel: boolean;
  cancelledBy?: string;
  lastHeartbeat: string; // ISO string for JSON
  createdAt: string;
}

interface ActionStateUpdate {
  runId: string;
  actionId?: string;
  sessionId?: string;
  taskId?: string;
  status?: ActionStatus;
  step?: string;
  cancel?: boolean;
  cancelledBy?: string;
}

// ─── Configurable data directory ───────────────────────────────────────────

let _dataDir: string | null = null;

/** Override the data directory (for testing). Defaults to process.cwd()/.kody-engine. */
export function _setDataDir(dir: string | null): void {
  _dataDir = dir;
}

function getDataDir(): string {
  // _dataDir holds the project root; .kody-engine is always a subdirectory of it.
  const base = _dataDir ?? path.join(process.cwd(), ".kody-engine");
  return path.join(base, ".kody-engine");
}

// ─── Persistence ───────────────────────────────────────────────────────────

function getFilePath(): string {
  return path.join(getDataDir(), "action-state.json");
}

function load(): Map<string, ActionState> {
  const map = new Map<string, ActionState>();
  try {
    const file = getFilePath();
    if (!fs.existsSync(file)) return map;
    const arr: ActionState[] = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const s of arr) {
      map.set(s.runId, s);
    }
  } catch {
    // Corrupt file — start fresh
  }
  return map;
}

function save(map: Map<string, ActionState>): void {
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(getFilePath(), JSON.stringify([...map.values()], null, 2));
  } catch {
    // Ignore write errors
  }
}

// ─── Operations ─────────────────────────────────────────────────────────────

/** Register or update an action's state. Requires matching actionId for updates. */
export function upsertActionState(update: ActionStateUpdate): ActionState | null {
  const map = load();
  const existing = map.get(update.runId);

  if (existing) {
    if (update.actionId && update.actionId !== existing.actionId) {
      return null; // Different instance — reject
    }
    const updated: ActionState = {
      ...existing,
      ...update,
      lastHeartbeat: new Date().toISOString(),
    };
    map.set(update.runId, updated);
    save(map);
    return updated;
  }

  const created: ActionState = {
    runId: update.runId,
    actionId: update.actionId ?? update.runId,
    sessionId: update.sessionId,
    taskId: update.taskId,
    status: update.status ?? "running",
    step: update.step ?? "",
    instructions: [],
    cancel: false,
    cancelledBy: undefined,
    lastHeartbeat: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  map.set(update.runId, created);
  save(map);
  return created;
}

export interface PollResult {
  instruction: string | null;
  cancel: boolean;
  cancelledBy: string | null;
  actionId: string;
  ownerActionId: string;
}

/** Pop the next instruction from the queue (FIFO). Persists the queue change. */
export function pollInstruction(runId: string, callerActionId: string): PollResult {
  const map = load();
  const state = map.get(runId);
  if (!state) {
    return { instruction: null, cancel: false, cancelledBy: null, actionId: "", ownerActionId: "" };
  }
  const instruction = state.instructions.shift() ?? null;
  map.set(runId, state);
  save(map);
  return {
    instruction,
    cancel: state.cancel,
    cancelledBy: state.cancelledBy ?? null,
    actionId: state.actionId,
    ownerActionId: callerActionId,
  };
}

/** Push an instruction onto the queue. */
export function enqueueInstruction(runId: string, instruction: string): boolean {
  const map = load();
  const state = map.get(runId);
  if (!state) return false;
  state.instructions.push(instruction);
  map.set(runId, state);
  save(map);
  return true;
}

/** Get full state for a runId. */
export function getActionState(runId: string): ActionState | null {
  return load().get(runId) ?? null;
}

/** List all action states, optionally filtered by sessionId. */
export function listActionStates(sessionId?: string): ActionState[] {
  const all = [...load().values()];
  if (sessionId) return all.filter((s) => s.sessionId === sessionId);
  return all;
}

/** Delete action state. */
export function deleteActionState(runId: string): boolean {
  const map = load();
  const deleted = map.delete(runId);
  if (deleted) save(map);
  return deleted;
}

/** Check if an action's heartbeat is stale (> timeoutMs). */
export function isActionStale(runId: string, timeoutMs = 60000): boolean {
  const state = load().get(runId);
  if (!state) return true;
  return Date.now() - new Date(state.lastHeartbeat).getTime() > timeoutMs;
}

/** Remove stale action states. Returns removed runIds. */
export function expireStaleActions(timeoutMs = 60000): string[] {
  const map = load();
  const expired: string[] = [];
  for (const [runId, state] of map.entries()) {
    if (Date.now() - new Date(state.lastHeartbeat).getTime() > timeoutMs) {
      map.delete(runId);
      expired.push(runId);
    }
  }
  if (expired.length > 0) save(map);
  return expired;
}

/** Register a chat session in the action-state queue for polling.
 *
 * Dashboard calls this via GitHub API (PUT contents) to register a session
 * before the workflow starts polling.
 *
 * @example
 * upsertChatSession("chat-issue-42-1234", "issue-42")
 */
export function upsertChatSession(runId: string, sessionId: string): ActionState | null {
  return upsertActionState({ runId, sessionId, status: "waiting", step: "chat" });
}

/** Enqueue a chat message for a running session.
 *
 * Dashboard calls this to send a message to a live chat session.
 *
 * @returns true if enqueued, false if session not found
 */
export function enqueueChatMessage(runId: string, message: string): boolean {
  return enqueueInstruction(runId, message);
}
