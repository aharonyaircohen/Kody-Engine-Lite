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
 * Logic:
 *  - prev is yesterday or earlier: next tick is today → we are in the
 *    pre-tick window → FIRE
 *  - prev is today and prevTime >= nowTime: we are at or after the tick
 *    within today → FIRE (only when prevMins >= nowMins, i.e. at exact tick)
 *  - prev is today and prevTime < nowTime: we fired recently, still in same
 *    window → DON'T fire
 */
export function cronMatches(cron: string, now: Date = new Date()): boolean {
  try {
    const interval = cronParser.parseExpression(cron, { utc: true, currentDate: now })
    const prev = interval.prev().toDate()

    const prevIsToday =
      prev.getUTCDate() === now.getUTCDate() &&
      prev.getUTCMonth() === now.getUTCMonth() &&
      prev.getUTCFullYear() === now.getUTCFullYear()

    if (prevIsToday) {
      // prev is today: fire only if prevTime >= nowTime (at or after tick)
      const prevMins = prev.getUTCHours() * 60 + prev.getUTCMinutes()
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes()
      return prevMins >= nowMins
    } else {
      // prev is yesterday or earlier: next tick is today → we are in the window
      return now.getTime() - prev.getTime() > CYCLE_MS
    }
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
