/**
 * @fileOverview Event System — PR State Store
 * @fileType store
 *
 * Tracks PR state for task PRs and session summary PRs.
 * Persisted to .kody-engine/pr-state.json in project root.
 */

import * as fs from "fs";
import * as path from "path";

export type PRStatus = "pending" | "open" | "merged" | "closed";

export interface TaskPRState {
  runId: string;
  sessionId?: string;
  taskId?: string;
  prNumber?: number;
  prUrl?: string;
  title: string;
  body: string;
  head: string;
  status: PRStatus;
  mergedAt?: string;
  createdAt: string;
}

// ─── Configurable data directory ───────────────────────────────────────────

let _dataDir: string | null = null;

/** Override the data directory (for testing). Defaults to process.cwd()/.kody-engine. */
export function _setDataDir(dir: string | null): void {
  _dataDir = dir;
}

function getDataDir(): string {
  // _dataDir holds the project root; .kody-engine is a subdirectory of it.
  const base = _dataDir ?? process.cwd();
  return path.join(base, ".kody-engine");
}

// ─── Persistence ───────────────────────────────────────────────────────────

function getFilePath(): string {
  return path.join(getDataDir(), "pr-state.json");
}

function load(): Map<string, TaskPRState> {
  const map = new Map<string, TaskPRState>();
  try {
    const file = getFilePath();
    if (!fs.existsSync(file)) return map;
    const arr: TaskPRState[] = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const pr of arr) {
      map.set(pr.runId, pr);
    }
  } catch {
    // Corrupt file — start fresh
  }
  return map;
}

function save(map: Map<string, TaskPRState>): void {
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(getFilePath(), JSON.stringify([...map.values()], null, 2));
  } catch {
    // Ignore write errors
  }
}

// ─── Operations ─────────────────────────────────────────────────────────────

/** Create or update PR state. */
export function upsertPRState(
  pr: Partial<TaskPRState> & { runId: string },
): TaskPRState {
  const map = load();
  const existing = map.get(pr.runId);
  const updated: TaskPRState = {
    runId: pr.runId,
    sessionId: pr.sessionId ?? existing?.sessionId,
    taskId: pr.taskId ?? existing?.taskId,
    prNumber: pr.prNumber ?? existing?.prNumber,
    prUrl: pr.prUrl ?? existing?.prUrl,
    title: pr.title ?? existing?.title ?? "",
    body: pr.body ?? existing?.body ?? "",
    head: pr.head ?? existing?.head ?? `pr-${pr.runId}`,
    status: pr.status ?? existing?.status ?? "pending",
    mergedAt: pr.mergedAt ?? existing?.mergedAt,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  map.set(pr.runId, updated);
  save(map);
  return updated;
}

/** Mark PR as open (created). */
export function markPRCreated(runId: string, prNumber: number, prUrl: string): TaskPRState | null {
  const map = load();
  const existing = map.get(runId);
  if (!existing) return null;
  existing.prNumber = prNumber;
  existing.prUrl = prUrl;
  existing.status = "open";
  map.set(runId, existing);
  save(map);
  return existing;
}

/** Mark PR as merged. */
export function markPRMerged(runId: string): TaskPRState | null {
  const map = load();
  const existing = map.get(runId);
  if (!existing) return null;
  existing.status = "merged";
  existing.mergedAt = new Date().toISOString();
  map.set(runId, existing);
  save(map);
  return existing;
}

/** Get PR state by runId. */
export function getPRState(runId: string): TaskPRState | null {
  return load().get(runId) ?? null;
}

/** Get all PRs for a session. */
export function getPRStatesBySession(sessionId: string): TaskPRState[] {
  return [...load().values()].filter((pr) => pr.sessionId === sessionId);
}

/** Get all open PRs for a session. */
export function getOpenPRsForSession(sessionId: string): TaskPRState[] {
  return getPRStatesBySession(sessionId).filter((pr) => pr.status === "open");
}

/** List all PR states. */
export function listPRStates(): TaskPRState[] {
  return [...load().values()];
}
