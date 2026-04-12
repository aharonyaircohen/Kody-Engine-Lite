import { describe, it, expect, beforeEach } from "vitest"
import { shouldRunOnCycle } from "../../src/watch/core/schedule.js"
import type { PluginSchedule, WatchAgentSchedule, StateStore } from "../../src/watch/core/types.js"

function createStateStore(): StateStore {
  const store = new Map<string, unknown>()
  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => { store.set(key, value) },
    save: () => { /* no-op for testing */ },
  }
}

function createDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute)
}

describe("Integration: watch schedule everyHours/everyDays", () => {
  let state: StateStore

  beforeEach(() => {
    state = createStateStore()
  })

  // ── everyHours ──────────────────────────────────────────────────────────────────

  it("everyHours=1 runs every cycle", () => {
    const schedule: PluginSchedule = { everyHours: 1 }
    // Cycle 0 = first fire
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 1, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 2, state)).toBe(true)
  })

  it("everyHours=2 fires every other cycle", () => {
    const schedule: PluginSchedule = { everyHours: 2 }
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 1, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 2, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 3, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 4, state)).toBe(true)
  })

  it("everyHours=4 fires on multiples of 4", () => {
    const schedule: PluginSchedule = { everyHours: 4 }
    for (let cycle = 0; cycle < 16; cycle++) {
      const expected = cycle % 4 === 0
      expect(shouldRunOnCycle(schedule, cycle, state)).toBe(expected)
    }
  })

  it("everyHours=0 is treated as always run", () => {
    const schedule: PluginSchedule = { everyHours: 0 }
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 100, state)).toBe(true)
  })

  it("everyHours works with WatchAgentSchedule type", () => {
    const schedule: WatchAgentSchedule = { everyHours: 3 }
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 1, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 2, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 3, state)).toBe(true)
  })

  // ── everyDays ─────────────────────────────────────────────────────────────────

  it("everyDays=1 runs once per day (every 96 cycles at 15-min interval)", () => {
    const schedule: PluginSchedule = { everyDays: 1 }
    // 1440 min/day / 15 min per cycle = 96 cycles/day
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 1, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 95, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 96, state)).toBe(true)
  })

  it("everyDays=2 fires every 192 cycles", () => {
    const schedule: PluginSchedule = { everyDays: 2 }
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 191, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 192, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 384, state)).toBe(true)
  })

  it("everyDays=0 is treated as always run", () => {
    const schedule: PluginSchedule = { everyDays: 0 }
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 1, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 1000, state)).toBe(true)
  })

  // ── Default behavior (no schedule) ─────────────────────────────────────────────

  it("undefined schedule always runs", () => {
    expect(shouldRunOnCycle(undefined, 0, state)).toBe(true)
    expect(shouldRunOnCycle(undefined, 1, state)).toBe(true)
    expect(shouldRunOnCycle(undefined, 999, state)).toBe(true)
  })

  it("empty schedule object always runs", () => {
    expect(shouldRunOnCycle({}, 0, state)).toBe(true)
    expect(shouldRunOnCycle({}, 100, state)).toBe(true)
  })

  // ── runAt time-based scheduling ──────────────────────────────────────────────
  // Note: the days=N check blocks re-runs within (N - 0.5) days of a prior call
  // to the SAME runAt time. Different runAt times are independent.

  it("runAt fires within cron window (days=0 disables interval check)", () => {
    // days=0 disables the days check, so we can test window logic in isolation.
    const win = (t: string, expect_: boolean, hour: number, min: number) =>
      expect(shouldRunOnCycle({ runAt: t, days: 0 }, 0, state, createDate(2026, 4, 10, hour, min))).toBe(expect_)
    // [08:00, 08:15) — each time is its own independent runAt schedule
    win("08:00", true, 8, 0); win("08:00", true, 8, 7); win("08:00", true, 8, 14)
    win("08:00", false, 8, 15); win("08:00", false, 7, 59)
    // [11:30, 11:45)
    win("11:30", true, 11, 30); win("11:30", true, 11, 44)
    win("11:30", false, 11, 45); win("11:30", false, 11, 29)
  })

  it("runAt blocks re-runs within the days interval", () => {
    // days=1: blocks re-runs within (1 - 0.5) = 0.5 days = 12h of the last run.
    // Apr10→Apr11 (1 day) is >= 0.5 threshold → fires. Use days=2 for a stricter block.
    expect(shouldRunOnCycle({ runAt: "09:00", days: 2 }, 0, state, createDate(2026, 4, 10, 9, 0))).toBe(true)
    expect(shouldRunOnCycle({ runAt: "09:00", days: 2 }, 0, state, createDate(2026, 4, 10, 9, 30))).toBe(false) // same day: 30min < 1.5d
    expect(shouldRunOnCycle({ runAt: "09:00", days: 2 }, 0, state, createDate(2026, 4, 11, 9, 0))).toBe(false) // next day: 1d < 1.5d
    expect(shouldRunOnCycle({ runAt: "09:00", days: 2 }, 0, state, createDate(2026, 4, 12, 9, 0))).toBe(true) // 2d later: fires
  })

  it("runAt with invalid time format returns false", () => {
    expect(shouldRunOnCycle({ runAt: "25:00", days: 1 } as any, 0, state)).toBe(false)
    expect(shouldRunOnCycle({ runAt: "bad", days: 1 } as any, 0, state)).toBe(false)
  })

  it("everyHours takes precedence over everyDays in the schedule union type", () => {
    const schedule: PluginSchedule = { everyHours: 4, everyDays: 1 }
    expect(shouldRunOnCycle(schedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(schedule, 1, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 2, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 3, state)).toBe(false)
    expect(shouldRunOnCycle(schedule, 4, state)).toBe(true)
  })

  it("runAt takes precedence over everyHours/everyDays in the schedule union type", () => {
    const schedule: PluginSchedule = { everyHours: 1, runAt: "15:00", days: 1 }
    // 15:05 is within [15:00, 15:15) — runAt fires, everyHours is NOT checked
    expect(shouldRunOnCycle(schedule, 0, state, createDate(2026, 4, 10, 15, 5))).toBe(true)
    // 16:00 is outside the 15:00 window — falls back to everyHours=1 → always runs
    expect(shouldRunOnCycle(schedule, 0, state, createDate(2026, 4, 10, 16, 0))).toBe(true)
  })

  it("matchesWatchAgentSchedule and PluginSchedule have identical schedule fields", () => {
    // Both types should support everyHours, everyDays, runAt, days
    const agentSchedule: WatchAgentSchedule = { everyHours: 6, everyDays: 0, runAt: "03:00", days: 7 }
    const pluginSchedule: PluginSchedule = { everyHours: 6, everyDays: 0, runAt: "03:00", days: 7 }

    expect(shouldRunOnCycle(agentSchedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(agentSchedule, 1, state)).toBe(false)
    expect(shouldRunOnCycle(agentSchedule, 2, state)).toBe(false)
    expect(shouldRunOnCycle(pluginSchedule, 0, state)).toBe(true)
    expect(shouldRunOnCycle(pluginSchedule, 1, state)).toBe(false)
    expect(shouldRunOnCycle(pluginSchedule, 2, state)).toBe(false)
  })
})
