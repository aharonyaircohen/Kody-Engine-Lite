/**
 * Prevents duplicate actions within a time window.
 */

import type { ActionRequest, WatchContext } from "./types.js"

/**
 * Check if an action should be deduplicated based on its dedupKey and execution history.
 */
export function shouldDedup(action: ActionRequest, ctx: WatchContext): boolean {
  if (!action.dedupKey) return false

  const windowMs = (action.dedupWindowMinutes ?? 60) * 60 * 1000
  const dedupKey = `dedup:${action.plugin}:${action.dedupKey}`

  const dedupEntries = ctx.state.get<Record<string, string>>("watch:dedupEntries") || {}
  const lastExecuted = dedupEntries[dedupKey]
  if (!lastExecuted) return false

  const lastTime = parseInt(lastExecuted, 10)
  if (Number.isNaN(lastTime)) return false

  return Date.now() - lastTime < windowMs
}

/**
 * Mark an action as executed in the state store.
 */
export function markExecuted(action: ActionRequest, ctx: WatchContext): void {
  if (!action.dedupKey) return

  const dedupKey = `dedup:${action.plugin}:${action.dedupKey}`
  const dedupEntries = ctx.state.get<Record<string, string>>("watch:dedupEntries") || {}
  dedupEntries[dedupKey] = String(Date.now())
  ctx.state.set("watch:dedupEntries", dedupEntries)
}

/**
 * Clean up expired dedup entries to prevent unbounded growth.
 */
export function cleanupExpiredDedup(ctx: WatchContext, maxAgeMs = 24 * 60 * 60 * 1000): number {
  const dedupEntries = ctx.state.get<Record<string, string>>("watch:dedupEntries") || {}
  const now = Date.now()
  let cleaned = 0

  const updated: Record<string, string> = {}

  for (const [key, timestamp] of Object.entries(dedupEntries)) {
    const time = parseInt(timestamp, 10)
    if (Number.isNaN(time) || now - time > maxAgeMs) {
      cleaned++
      continue
    }
    updated[key] = timestamp
  }

  ctx.state.set("watch:dedupEntries", updated)
  return cleaned
}
