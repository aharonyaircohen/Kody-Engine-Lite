/**
 * Schedule-matching utilities for watch plugins and agents.
 *
 * Supports:
 *  - everyHours: run every N hours
 *  - everyDays:  run every N days
 *  - runAt/days: run at a specific time of day, every N days (needs state persistence)
 */

import type { PluginSchedule, WatchAgentSchedule, StateStore } from "./types.js"

/** Minutes between each watch cron fire (matches cron interval) */
const CRON_INTERVAL_MINUTES = 15

/**
 * Returns true if a plugin/agent should run on this cycle.
 *
 * @param schedule - The schedule config from a plugin or agent.
 * @param cycleNumber - Current watch cycle count.
 * @param state - Persistent state store (used for day-tracking with runAt).
 * @param now - Current date (injectable for testing).
 */
export function shouldRunOnCycle(
  schedule: PluginSchedule | WatchAgentSchedule | undefined,
  cycleNumber: number,
  state: StateStore,
  now: Date = new Date(),
): boolean {
  if (!schedule) return true

  // ── Hour-based scheduling ─────────────────────────────────────────────────
  if (schedule.everyHours) {
    const interval = (schedule.everyHours * 60) / CRON_INTERVAL_MINUTES
    if (interval <= 0) return true
    return cycleNumber % interval === 0
  }

  // ── Day-based scheduling ──────────────────────────────────────────────────
  if (schedule.everyDays) {
    const interval = (schedule.everyDays * 24 * 60) / CRON_INTERVAL_MINUTES
    if (interval <= 0) return true
    return cycleNumber % interval === 0
  }

  // ── Time-based scheduling (runAt) ───────────────────────────────────────
  if (schedule.runAt) {
    return matchesRunAt(schedule.runAt, schedule.days ?? 1, state, now)
  }

  return true
}

/**
 * Checks whether `now` falls within the cron window starting at `runAt`,
 * and that enough days have elapsed since the last run.
 */
function matchesRunAt(
  runAt: string,
  days: number,
  state: StateStore,
  now: Date,
): boolean {
  const parsed = parseHHmm(runAt)
  if (!parsed) return false

  const { hours, minutes } = parsed
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const targetMinutes = hours * 60 + minutes

  // Check if we're within the cron window [target, target + CRON_INTERVAL_MINUTES)
  if (nowMinutes < targetMinutes || nowMinutes >= targetMinutes + CRON_INTERVAL_MINUTES) {
    return false
  }

  // Check day interval
  const stateKey = `schedule:lastRunAt:${runAt}`
  const lastRunStr = state.get<string>(stateKey)

  if (lastRunStr) {
    const lastRun = new Date(lastRunStr)
    if (!isNaN(lastRun.getTime())) {
      const elapsedMs = now.getTime() - lastRun.getTime()
      const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000)
      if (elapsedDays < days - 0.5) {
        // Not enough days elapsed (0.5 day tolerance for cron jitter)
        return false
      }
    }
  }

  // Mark this run
  state.set(stateKey, now.toISOString())
  return true
}

function parseHHmm(time: string): { hours: number; minutes: number } | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return { hours, minutes }
}
