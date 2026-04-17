/**
 * Cross-process write lock for the graph store.
 *
 * All mutating paths must hold this lock for the duration of their
 * read-modify-write cycle. Guarantees:
 *   1. No two processes can interleave reads and writes on `.kody/graph/*`
 *   2. `writeFactOnce` sees the latest state between its factExists check
 *      and its writeFact (TOCTOU safety)
 *   3. Nudge episode backfill runs in a single critical section with its
 *      node writes
 *
 * Stale locks (>30s old) are reclaimed automatically via proper-lockfile's
 * stale-detection — a crashed process cannot deadlock future writers.
 *
 * Sync path: proper-lockfile's lockSync does not support retries, so we
 * loop manually using Atomics.wait for a non-CPU-spinning sync sleep.
 */

import * as fs from "fs"
import * as path from "path"
import lockfile from "proper-lockfile"
import { traced } from "./trace.js"

const LOCK_BASENAME = ".graph-lock"
const STALE_MS = 30_000
const MAX_ATTEMPTS = 60
const BASE_DELAY_MS = 25
const MAX_DELAY_MS = 300

// Shared buffer for sync sleep via Atomics.wait — does not spin the CPU.
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))

function syncSleep(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms)
}

function getLockTarget(projectDir: string): string {
  const graphDir = path.join(projectDir, ".kody", "graph")
  fs.mkdirSync(graphDir, { recursive: true })
  const target = path.join(graphDir, LOCK_BASENAME)
  // proper-lockfile locks a sentinel *file* (it creates a sibling `.lock` dir).
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, "")
  }
  return target
}

/**
 * Run `fn` while holding the graph write lock. Synchronous — safe to wrap
 * existing sync APIs without making them async.
 */
export function withGraphLockSync<T>(projectDir: string, fn: () => T): T {
  return traced("graph.lock", () => {
    const target = getLockTarget(projectDir)
    let release: (() => void) | undefined
    let lastErr: unknown

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        release = lockfile.lockSync(target, { stale: STALE_MS })
        break
      } catch (err) {
        lastErr = err
        // ELOCKED / already-locked — back off and retry
        const delay = Math.min(BASE_DELAY_MS * Math.pow(1.5, attempt), MAX_DELAY_MS)
        syncSleep(delay)
      }
    }

    if (!release) {
      throw new Error(
        `Could not acquire graph lock at ${target} after ${MAX_ATTEMPTS} attempts: ` +
        (lastErr instanceof Error ? lastErr.message : String(lastErr)),
      )
    }

    try {
      return fn()
    } finally {
      try {
        release()
      } catch {
        // Lock may have already been released (e.g. stale-reclaimed). Best-effort.
      }
    }
  })
}

/**
 * Async variant for callers that are already async (e.g. nudge).
 */
export async function withGraphLock<T>(
  projectDir: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const target = getLockTarget(projectDir)
  const release = await lockfile.lock(target, {
    stale: STALE_MS,
    retries: {
      retries: 50,
      minTimeout: 20,
      maxTimeout: 200,
      factor: 1.5,
    },
  })
  try {
    return await fn()
  } finally {
    await release()
  }
}
