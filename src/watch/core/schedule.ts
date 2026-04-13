/**
 * Schedule-matching utilities for watch agents using standard cron expressions.
 *
 * Stateless: evaluates against current time only, no lastRunAt tracking.
 */

import type { WatchAgentConfig } from "./types.js"
import * as cronParser from "cron-parser"

/** Minutes between each watch engine fire (GitHub cron interval). */
const CRON_INTERVAL_MINUTES = 30

/**
 * Returns true if the cron expression fires within the current 30-minute window.
 *
 * Strategy: use prev() to find the last tick before "now". If that tick is
 * today, we're in (or past) the firing window. If it's yesterday or earlier,
 * the next tick is tomorrow or later — don't fire.
 *
 * Note: cron-parser treats currentDate as already passed, so at exactly tick
 * time, prev() returns the previous cycle (not current). We handle this by
 * checking both prev() and next() to cover the "at the tick" edge case.
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
    const interval = cronParser.parseExpression(cron, { utc: true, currentDate: now })
    const prev = interval.prev().toDate()

    const prevIsToday =
      prev.getUTCFullYear() === now.getUTCFullYear() &&
      prev.getUTCMonth() === now.getUTCMonth() &&
      prev.getUTCDate() === now.getUTCDate()

    if (prevIsToday) {
      const tickMins = prev.getUTCHours() * 60 + prev.getUTCMinutes()
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes()
      if (nowMins >= tickMins && nowMins < tickMins + CRON_INTERVAL_MINUTES) return true

      // Edge case: we're at exactly the NEXT tick time (e.g. hourly cron: at 04:00
      // prev=03:00 so we missed the 03:00 window, but we might be AT the 04:00 tick).
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

    // prev is NOT today. Check if the next tick IS today.
    const next = interval.next().toDate()
    const nextIsToday =
      next.getUTCFullYear() === now.getUTCFullYear() &&
      next.getUTCMonth() === now.getUTCMonth() &&
      next.getUTCDate() === now.getUTCDate()

    if (!nextIsToday) return false

    const tickMins = next.getUTCHours() * 60 + next.getUTCMinutes()
    const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes()
    return nowMins >= tickMins && nowMins < tickMins + CRON_INTERVAL_MINUTES
  } catch {
    return false
  }
}

/**
 * Determines whether a watch agent should run on this cycle.
 * Uses cronMatches to evaluate the agent's cron expression against the current time.
 */
export function shouldAgentRun(
  agentConfig: WatchAgentConfig,
  _cycleNumber: number,
  now: Date = new Date(),
): boolean {
  return cronMatches(agentConfig.cron, now)
}
