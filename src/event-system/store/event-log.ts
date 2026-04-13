/**
 * @fileOverview Event System — Event Log Store
 * @fileType store
 *
 * Append-only audit log of all events emitted.
 * Persisted to .kody-engine/event-log.json in project root.
 */

import * as fs from "fs";
import * as path from "path";
import type { EventName } from "../events/types.js";

export interface EventLogEntry {
  id: string;
  runId: string;
  event: EventName;
  payload: Record<string, unknown>;
  hooksFired: string[];
  hookErrors: Record<string, string>;
  emittedAt: string;
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

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getFilePath(): string {
  return path.join(getDataDir(), "event-log.json");
}

function load(): EventLogEntry[] {
  try {
    const file = getFilePath();
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf-8")) as EventLogEntry[];
  } catch {
    return [];
  }
}

function save(entries: EventLogEntry[]): void {
  try {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    // Keep last 10k entries to avoid unbounded growth
    fs.writeFileSync(getFilePath(), JSON.stringify(entries.slice(-10000), null, 2));
  } catch {
    // Ignore write errors
  }
}

// ─── Operations ─────────────────────────────────────────────────────────────

/** Append a new event log entry. */
export function logEvent(
  runId: string,
  event: EventName,
  payload: Record<string, unknown>,
  hooksFired: string[] = [],
  hookErrors: Record<string, string> = {},
): EventLogEntry {
  const entries = load();
  const entry: EventLogEntry = {
    id: generateId(),
    runId,
    event,
    payload,
    hooksFired,
    hookErrors,
    emittedAt: new Date().toISOString(),
  };
  entries.push(entry);
  save(entries);
  return entry;
}

/** Get all events for a specific runId. */
export function getEventHistory(runId: string): EventLogEntry[] {
  return load().filter((e) => e.runId === runId);
}

/** Get the most recent event for a runId. */
export function getLastEvent(runId: string): EventLogEntry | null {
  const entries = load();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].runId === runId) return entries[i];
  }
  return null;
}

/** Get the last event of a specific type for a runId. */
export function getLastEventOfType(runId: string, event: EventName): EventLogEntry | null {
  const entries = load();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].runId === runId && entries[i].event === event) return entries[i];
  }
  return null;
}

/** Update the last entry's hook results. */
export function updateLastEntry(
  hooksFired: string[],
  hookErrors: Record<string, string>,
): void {
  const entries = load();
  const last = entries[entries.length - 1];
  if (last) {
    last.hooksFired = hooksFired;
    last.hookErrors = hookErrors;
    save(entries);
  }
}

/** Count events by type for a runId. */
export function countEvents(runId: string): Partial<Record<EventName, number>> {
  const result: Partial<Record<EventName, number>> = {};
  for (const entry of load()) {
    if (entry.runId !== runId) continue;
    result[entry.event] = (result[entry.event] ?? 0) + 1;
  }
  return result;
}
