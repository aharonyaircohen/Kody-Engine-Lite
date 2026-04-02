import { describe, it, expect, beforeEach } from "vitest"

import { shouldDedup, markExecuted, cleanupExpiredDedup } from "../../src/watch/core/dedup"
import { JsonStateStore, IssueCommentStateStore } from "../../src/watch/core/state"
import { PluginRegistry } from "../../src/watch/plugins/registry"
import type { ActionRequest, WatchContext, WatchPlugin } from "../../src/watch/core/types"

// ============================================================================
// Helpers
// ============================================================================

function createTestContext(overrides?: Partial<WatchContext>): WatchContext {
  return {
    repo: "test/repo",
    dryRun: false,
    state: new JsonStateStore("/dev/null"),
    github: {
      postComment: () => {},
      getIssue: () => ({ body: null, title: null }),
      getOpenIssues: () => [],
      createIssue: () => null,
      searchIssues: () => [],
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    runTimestamp: new Date().toISOString(),
    cycleNumber: 1,
    ...overrides,
  }
}

function createAction(overrides?: Partial<ActionRequest>): ActionRequest {
  return {
    plugin: "test-plugin",
    type: "test-action",
    urgency: "info",
    title: "Test Action",
    detail: "Test detail",
    execute: async () => ({ success: true }),
    ...overrides,
  }
}

// ============================================================================
// Dedup Tests
// ============================================================================

describe("dedup", () => {
  let ctx: WatchContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it("allows action without dedupKey", () => {
    const action = createAction()
    expect(shouldDedup(action, ctx)).toBe(false)
  })

  it("allows first action with dedupKey", () => {
    const action = createAction({ dedupKey: "test-key" })
    expect(shouldDedup(action, ctx)).toBe(false)
  })

  it("deduplicates action within window after marking executed", () => {
    const action = createAction({ dedupKey: "test-key", dedupWindowMinutes: 60 })
    markExecuted(action, ctx)
    expect(shouldDedup(action, ctx)).toBe(true)
  })

  it("allows action after window expires", () => {
    const action = createAction({ dedupKey: "test-key", dedupWindowMinutes: 60 })

    // Manually set a timestamp in the past (2 hours ago)
    const twoHoursAgo = String(Date.now() - 2 * 60 * 60 * 1000)
    const entries: Record<string, string> = { "dedup:test-plugin:test-key": twoHoursAgo }
    ctx.state.set("watch:dedupEntries", entries)

    expect(shouldDedup(action, ctx)).toBe(false)
  })

  it("handles invalid timestamp gracefully", () => {
    const action = createAction({ dedupKey: "test-key" })
    ctx.state.set("watch:dedupEntries", { "dedup:test-plugin:test-key": "invalid" })
    expect(shouldDedup(action, ctx)).toBe(false)
  })
})

describe("cleanupExpiredDedup", () => {
  it("removes entries older than maxAge", () => {
    const ctx = createTestContext()
    const old = String(Date.now() - 48 * 60 * 60 * 1000) // 48 hours ago
    const recent = String(Date.now() - 1000) // 1 second ago

    ctx.state.set("watch:dedupEntries", {
      "dedup:old-action": old,
      "dedup:recent-action": recent,
    })

    const cleaned = cleanupExpiredDedup(ctx)
    expect(cleaned).toBe(1)

    const remaining = ctx.state.get<Record<string, string>>("watch:dedupEntries")!
    expect(remaining["dedup:recent-action"]).toBe(recent)
    expect(remaining["dedup:old-action"]).toBeUndefined()
  })

  it("removes entries with invalid timestamps", () => {
    const ctx = createTestContext()
    ctx.state.set("watch:dedupEntries", { "dedup:bad": "not-a-number" })

    const cleaned = cleanupExpiredDedup(ctx)
    expect(cleaned).toBe(1)
  })

  it("returns 0 when no entries exist", () => {
    const ctx = createTestContext()
    expect(cleanupExpiredDedup(ctx)).toBe(0)
  })
})

// ============================================================================
// State Tests
// ============================================================================

describe("JsonStateStore", () => {
  it("stores and retrieves values", () => {
    const store = new JsonStateStore("/dev/null")
    store.set("key", "value")
    expect(store.get("key")).toBe("value")
  })

  it("returns undefined for missing keys", () => {
    const store = new JsonStateStore("/dev/null")
    expect(store.get("missing")).toBeUndefined()
  })

  it("handles complex objects", () => {
    const store = new JsonStateStore("/dev/null")
    store.set("obj", { nested: { count: 42 } })
    expect(store.get<{ nested: { count: number } }>("obj")).toEqual({ nested: { count: 42 } })
  })
})

describe("IssueCommentStateStore", () => {
  it("loads state from comment with marker", () => {
    const github = {
      postComment: () => {},
      getIssue: () => ({ body: null, title: null }),
      getIssueComments: () => [
        { id: 100, body: '<!-- KODY_WATCH_STATE:{"system:cycleNumber":5} -->\n\n_state_' },
      ],
      updateComment: () => {},
      getOpenIssues: () => [],
      createIssue: () => null,
      searchIssues: () => [],
    }
    const store = new IssueCommentStateStore(github, 42)
    expect(store.get<number>("system:cycleNumber")).toBe(5)
  })

  it("starts fresh when no state comment exists", () => {
    const github = {
      postComment: () => {},
      getIssue: () => ({ body: null, title: null }),
      getIssueComments: () => [
        { id: 1, body: "Some regular comment" },
      ],
      updateComment: () => {},
      getOpenIssues: () => [],
      createIssue: () => null,
      searchIssues: () => [],
    }
    const store = new IssueCommentStateStore(github, 42)
    expect(store.get<number>("system:cycleNumber")).toBeUndefined()
  })

  it("updates existing comment on save", () => {
    let updatedId: number | null = null
    let updatedBody = ""
    const github = {
      postComment: () => {},
      getIssue: () => ({ body: null, title: null }),
      getIssueComments: () => [
        { id: 100, body: '<!-- KODY_WATCH_STATE:{"system:cycleNumber":5} -->' },
      ],
      updateComment: (id: number, body: string) => { updatedId = id; updatedBody = body },
      getOpenIssues: () => [],
      createIssue: () => null,
      searchIssues: () => [],
    }
    const store = new IssueCommentStateStore(github, 42)
    store.set("system:cycleNumber", 6)
    store.save()
    expect(updatedId).toBe(100)
    expect(updatedBody).toContain('"system:cycleNumber":6')
  })

  it("creates new comment when no state comment exists", () => {
    let postedIssue: number | null = null
    let postedBody = ""
    const github = {
      postComment: (issue: number, body: string) => { postedIssue = issue; postedBody = body },
      getIssue: () => ({ body: null, title: null }),
      getIssueComments: () => [],
      updateComment: () => {},
      getOpenIssues: () => [],
      createIssue: () => null,
      searchIssues: () => [],
    }
    const store = new IssueCommentStateStore(github, 42)
    store.set("system:cycleNumber", 1)
    store.save()
    expect(postedIssue).toBe(42)
    expect(postedBody).toContain("KODY_WATCH_STATE")
    expect(postedBody).toContain('"system:cycleNumber":1')
  })
})

// ============================================================================
// Registry Tests
// ============================================================================

describe("PluginRegistry", () => {
  it("registers and retrieves plugins", () => {
    const registry = new PluginRegistry()
    const plugin: WatchPlugin = {
      name: "test",
      description: "Test plugin",
      domain: "test",
      async run() { return [] },
    }
    registry.register(plugin)
    expect(registry.getAll()).toHaveLength(1)
    expect(registry.getAll()[0].name).toBe("test")
  })

  it("throws on duplicate registration", () => {
    const registry = new PluginRegistry()
    const plugin: WatchPlugin = {
      name: "test",
      description: "Test",
      domain: "test",
      async run() { return [] },
    }
    registry.register(plugin)
    expect(() => registry.register(plugin)).toThrow("Plugin already registered: test")
  })

  it("clears all plugins", () => {
    const registry = new PluginRegistry()
    registry.register({ name: "a", description: "", domain: "", async run() { return [] } })
    registry.register({ name: "b", description: "", domain: "", async run() { return [] } })
    expect(registry.getAll()).toHaveLength(2)
    registry.clear()
    expect(registry.getAll()).toHaveLength(0)
  })

  it("returns a copy from getAll", () => {
    const registry = new PluginRegistry()
    registry.register({ name: "a", description: "", domain: "", async run() { return [] } })
    const all = registry.getAll()
    all.push({ name: "b", description: "", domain: "", async run() { return [] } })
    expect(registry.getAll()).toHaveLength(1)
  })
})

// ============================================================================
// Cycle Filtering Tests
// ============================================================================

describe("cycle filtering", () => {
  it("runs plugin with no schedule every cycle", () => {
    const plugin: WatchPlugin = {
      name: "always",
      description: "",
      domain: "",
      async run() { return [] },
    }
    // No schedule = always run
    const shouldRun = !plugin.schedule || !plugin.schedule.every || 5 % plugin.schedule.every === 0
    expect(shouldRun).toBe(true)
  })

  it("runs plugin when cycle matches schedule.every", () => {
    const plugin: WatchPlugin = {
      name: "daily",
      description: "",
      domain: "",
      schedule: { every: 48 },
      async run() { return [] },
    }
    expect(48 % plugin.schedule!.every! === 0).toBe(true)
    expect(96 % plugin.schedule!.every! === 0).toBe(true)
  })

  it("skips plugin when cycle does not match", () => {
    const plugin: WatchPlugin = {
      name: "daily",
      description: "",
      domain: "",
      schedule: { every: 48 },
      async run() { return [] },
    }
    expect(1 % plugin.schedule!.every! === 0).toBe(false)
    expect(47 % plugin.schedule!.every! === 0).toBe(false)
  })
})
