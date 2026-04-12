/**
 * Schedule-matching utilities for watch agents.
 *
 * Supports:
 *  - cron: standard 5-field cron expression (replaces runAt/everyHours/everyDays)
 *  - Legacy schedule object for backward compat during migration
 *
 * Stateless: evaluates against current time only, no lastRunAt tracking.
 */

import type { WatchAgentConfig } from "./types.js"
import * as cronParser from "cron-parser"

/** Minutes between each watch engine fire (GitHub cron interval). */
const CRON_INTERVAL_MINUTES = 30
const CYCLE_MS = CRON_INTERVAL_MINUTES * 60 * 1000

/**
 * Returns true if the agent should fire on this engine cycle.
 *
 * Approach: find whether the cron fires today, and if so, whether the current
 * time falls within the firing window (tick_time to tick_time + CYCLE_MS).
 *
 * Step 1 — does the cron fire today? Build "today at tick time" by taking the
 * cron expression, substituting today's year/month/day, and asking cron-parser
 * if that date would have matched when evaluated at that exact time. This
 * avoids the ambiguity of calling prev()/next() on an iterator whose position
 * may not correspond to "now".
 *
 * Step 2 — if the cron fires today, check whether now falls within the window
 * [tick_time, tick_time + CYCLE_MS]. Fire only once per cycle window.
 */
export function cronMatches(cron: string, now: Date = new Date()): boolean {
  try {
    // ── Fast path for simple interval crons (e.g. "*/30", "*/15", "*/60") ──
    const intervalMatch = cron.match(/^(\*|0)\/(\d+)\s+\*\s+\*\s+\*(\s+\S+)*$/)
    if (intervalMatch) {
      const intervalMins = parseInt(intervalMatch[2], 10)
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes()
      const prevTick = Math.floor(nowMins / intervalMins) * intervalMins
      const windowEnd = prevTick + CRON_INTERVAL_MINUTES
      return nowMins < windowEnd
    }

    // ── General path via cron-parser ─────────────────────────────────────────
    // Strategy: use prev() to find the last tick before "now". If that tick is
    // today, we're in (or past) the firing window. If it's yesterday or earlier,
    // the next tick is tomorrow or later — don't fire.
    // Note: cron-parser treats currentDate as already passed, so at exactly tick
    // time, prev() returns the previous cycle (not current). We handle this by
    // checking both prev() and next() to cover the "at the tick" edge case.
    const interval = cronParser.parseExpression(cron, { utc: true, currentDate: now })
    const prev = interval.prev().toDate()

    const prevIsToday =
      prev.getUTCFullYear() === now.getUTCFullYear() &&
      prev.getUTCMonth() === now.getUTCMonth() &&
      prev.getUTCDate() === now.getUTCDate()

    if (prevIsToday) {
      // Tick was earlier today. Check if we're still within the firing window
      // (tick_time to tick_time + CYCLE_MS).
      const tickMins = prev.getUTCHours() * 60 + prev.getUTCMinutes()
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes()
      if (nowMins >= tickMins && nowMins < tickMins + CRON_INTERVAL_MINUTES) return true
      // Edge case: we're at exactly the NEXT tick time (e.g. hourly cron: at 04:00
      // prev=03:00 so we missed the 03:00 window, but we might be AT the 04:00 tick).
      // Check if next tick is also today and we're at or past it.
      const next = interval.next().toDate()
      const nextIsToday =
        next.getUTCFullYear() === now.getUTCFullYear() &&
        next.getUTCMonth() === now.getUTCMonth() &&
        next.getUTCDate() === now.getUTCDate()
      if (nextIsToday) {
        const nextTickMins = next.getUTCHours() * 60 + next.getUTCMinutes()
        return nowMins >= nextTickMins && nowMins < nextTickMins + CRON_INTERVAL_MINUTES
      }
      return false
    }

    // prev is NOT today. Check if the next tick IS today (we're before today's tick).
    const next = interval.next().toDate()
    const nextIsToday =
      next.getUTCFullYear() === now.getUTCFullYear() &&
      next.getUTCMonth() === now.getUTCMonth() &&
      next.getUTCDate() === now.getUTCDate()

    if (!nextIsToday) return false

    // We're before today's tick. Fire if we're at or past the tick time.
    const tickMins = next.getUTCHours() * 60 + next.getUTCMinutes()
    const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes()
    return nowMins >= tickMins && nowMins < tickMins + CRON_INTERVAL_MINUTES
  } catch {
    return false
  }
}

/**
 * Determines whether a watch agent should run on this cycle.
 *
 * - If agent has a `cron` field, use stateless cronMatches().
 * - Otherwise fall back to legacy shouldRunOnCycle (backward compat for
 *   repos still using schedule: { runAt, everyHours, everyDays }).
 */
export function shouldAgentRun(
  agentConfig: WatchAgentConfig,
  cycleNumber: number,
  now: Date = new Date(),
): boolean {
  if (agentConfig.cron) {
    return cronMatches(agentConfig.cron, now)
  }

  // Legacy path: schedule object (backward compat)
  const { schedule } = agentConfig
  if (!schedule) return true

  if (schedule.runAt) {
    const parsed = parseHHmm(schedule.runAt)
    if (!parsed) return false
    const { hours, minutes } = parsed
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()
    const targetMinutes = hours * 60 + minutes
    const windowStart = targetMinutes
    const windowEnd = targetMinutes + CRON_INTERVAL_MINUTES
    if (nowMinutes >= windowStart && nowMinutes < windowEnd) return true
    if (windowEnd > 24 * 60 && nowMinutes < windowEnd - 24 * 60) return true
    return false
  }

  if (schedule.everyHours) {
    if (schedule.everyHours <= 0) return true
    return cycleNumber % schedule.everyHours === 0
  }

  if (schedule.everyDays) {
    const interval = (schedule.everyDays * 24 * 60) / CRON_INTERVAL_MINUTES
    if (interval <= 0) return true
    return cycleNumber % interval === 0
  }

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
