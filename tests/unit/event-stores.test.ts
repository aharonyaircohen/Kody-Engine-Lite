/**
 * Unit tests for event system stores:
 * - event-log.ts    — append-only audit log
 * - action-state.ts — action polling state
 * - pr-state.ts     — PR creation tracking
 *
 * All stores accept a configurable data directory via _setDataDir().
 * The top-level beforeEach sets _dataDir for all three stores before
 * any store function is called, so process.cwd() captured at import
 * time is irrelevant.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-store-test-"))
  fs.mkdirSync(path.join(tmpDir, ".kody-engine"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── Shared helpers ─────────────────────────────────────────────────────────────

function readJsonArray(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return []
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown[]
}

// ─── Store function bindings ────────────────────────────────────────────────────

// event-log
let logEvent!: (...args: any[]) => any
let getEventHistory!: (...args: any[]) => any
let getLastEvent!: (...args: any[]) => any
let getLastEventOfType!: (...args: any[]) => any
let updateLastEntry!: (...args: any[]) => any
let countEvents!: (...args: any[]) => any

// action-state
let upsertActionState!: (...args: any[]) => any
let pollInstruction!: (...args: any[]) => any
let enqueueInstruction!: (...args: any[]) => any
let getActionState!: (...args: any[]) => any
let listActionStates!: (...args: any[]) => any
let deleteActionState!: (...args: any[]) => any
let isActionStale!: (...args: any[]) => any
let expireStaleActions!: (...args: any[]) => any
let upsertChatSession!: (...args: any[]) => any
let enqueueChatMessage!: (...args: any[]) => any

// pr-state
let upsertPRState!: (...args: any[]) => any
let markPRCreated!: (...args: any[]) => any
let markPRMerged!: (...args: any[]) => any
let getPRState!: (...args: any[]) => any
let getPRStatesBySession!: (...args: any[]) => any
let getOpenPRsForSession!: (...args: any[]) => any
let listPRStates!: (...args: any[]) => any

// Populate all store bindings — must be called after _setDataDir is set.
async function importStores() {
  // event-log
  const eventLog = await import("../../src/event-system/store/event-log.js")
  logEvent = eventLog.logEvent
  getEventHistory = eventLog.getEventHistory
  getLastEvent = eventLog.getLastEvent
  getLastEventOfType = eventLog.getLastEventOfType
  updateLastEntry = eventLog.updateLastEntry
  countEvents = eventLog.countEvents

  // action-state
  const actionState = await import("../../src/event-system/store/action-state.js")
  upsertActionState = actionState.upsertActionState
  pollInstruction = actionState.pollInstruction
  enqueueInstruction = actionState.enqueueInstruction
  getActionState = actionState.getActionState
  listActionStates = actionState.listActionStates
  deleteActionState = actionState.deleteActionState
  isActionStale = actionState.isActionStale
  expireStaleActions = actionState.expireStaleActions

  // pr-state
  const prState = await import("../../src/event-system/store/pr-state.js")
  upsertPRState = prState.upsertPRState
  markPRCreated = prState.markPRCreated
  markPRMerged = prState.markPRMerged
  getPRState = prState.getPRState
  getPRStatesBySession = prState.getPRStatesBySession
  getOpenPRsForSession = prState.getOpenPRsForSession
  listPRStates = prState.listPRStates
}

// ─── event-log Tests ────────────────────────────────────────────────────────────

describe("event-log", () => {
  beforeEach(async () => {
    // Set data dir BEFORE importing the store module.
    // The store module is evaluated at import() time, but _dataDir is
    // a mutable module variable — setting it here affects all subsequent
    // function calls through the bound variables.
    const eventLog = await import("../../src/event-system/store/event-log.js")
    const setter = eventLog._setDataDir as (dir: string | null) => void
    setter(tmpDir)
    // Bind functions after _setDataDir is set
    logEvent = eventLog.logEvent
    getEventHistory = eventLog.getEventHistory
    getLastEvent = eventLog.getLastEvent
    getLastEventOfType = eventLog.getLastEventOfType
    updateLastEntry = eventLog.updateLastEntry
    countEvents = eventLog.countEvents
  })

  describe("logEvent", () => {
    it("creates the event log file and appends an entry", () => {
      const entry = logEvent("run-1", "pipeline.started", { runId: "run-1" })

      expect(entry.id).toBeTruthy()
      expect(entry.runId).toBe("run-1")
      expect(entry.event).toBe("pipeline.started")

      const entries = readJsonArray(path.join(tmpDir, ".kody-engine/event-log.json"))
      expect(entries).toHaveLength(1)
      expect((entries[0] as any).runId).toBe("run-1")
    })

    it("appends multiple entries", () => {
      logEvent("run-1", "pipeline.started", { runId: "run-1" })
      logEvent("run-1", "step.started", { runId: "run-1", step: "build" })
      logEvent("run-1", "pipeline.success", { runId: "run-1" })

      const entries = readJsonArray(path.join(tmpDir, ".kody-engine/event-log.json"))
      expect(entries).toHaveLength(3)
    })

    it("includes hook results in the entry", () => {
      const entry = logEvent("run-1", "pipeline.started", { runId: "run-1" }, ["log"], {})
      expect(entry.hooksFired).toEqual(["log"])
      expect(entry.hookErrors).toEqual({})
    })

    it("starts fresh on corrupt JSON", () => {
      const file = path.join(tmpDir, ".kody-engine/event-log.json")
      fs.writeFileSync(file, "not valid json {{{")
      const entry = logEvent("run-1", "pipeline.started", { runId: "run-1" })
      expect(entry.runId).toBe("run-1")

      const entries = readJsonArray(file)
      expect(entries).toHaveLength(1)
    })
  })

  describe("getEventHistory", () => {
    it("returns all events for a runId", () => {
      logEvent("run-1", "pipeline.started", { runId: "run-1" })
      logEvent("run-1", "step.started", { runId: "run-1", step: "build" })
      logEvent("run-2", "pipeline.started", { runId: "run-2" })

      const history = getEventHistory("run-1")
      expect(history).toHaveLength(2)
      expect(history.every((e: any) => e.runId === "run-1")).toBe(true)
    })

    it("returns empty array for unknown runId", () => {
      expect(getEventHistory("unknown-run")).toHaveLength(0)
    })
  })

  describe("getLastEvent", () => {
    it("returns the most recent event for a runId", () => {
      logEvent("run-1", "pipeline.started", { runId: "run-1" })
      logEvent("run-1", "step.started", { runId: "run-1", step: "build" })
      logEvent("run-1", "pipeline.success", { runId: "run-1" })

      const last = getLastEvent("run-1")
      expect(last?.event).toBe("pipeline.success")
    })

    it("returns null for unknown runId", () => {
      expect(getLastEvent("unknown")).toBeNull()
    })
  })

  describe("getLastEventOfType", () => {
    it("returns the last event of a specific type", () => {
      logEvent("run-1", "pipeline.started", { runId: "run-1" })
      logEvent("run-1", "step.started", { runId: "run-1", step: "build" })
      logEvent("run-1", "pipeline.started", { runId: "run-1" })

      const last = getLastEventOfType("run-1", "pipeline.started")
      expect(last?.event).toBe("pipeline.started")
    })

    it("returns null when no event of that type exists", () => {
      logEvent("run-1", "pipeline.started", { runId: "run-1" })
      expect(getLastEventOfType("run-1", "chat.done")).toBeNull()
    })
  })

  describe("updateLastEntry", () => {
    it("updates the hooksFired and hookErrors on the last entry", () => {
      logEvent("run-1", "pipeline.started", { runId: "run-1" })
      logEvent("run-2", "pipeline.started", { runId: "run-2" })

      updateLastEntry(["log", "github-label"], { log: "timeout" })

      const last = getLastEvent("run-2")
      expect(last?.hooksFired).toEqual(["log", "github-label"])
      expect(last?.hookErrors).toEqual({ log: "timeout" })
    })

    it("is a no-op when log is empty", () => {
      expect(() => updateLastEntry([], {})).not.toThrow()
    })
  })

  describe("countEvents", () => {
    it("counts events by type for a runId", () => {
      logEvent("run-1", "pipeline.started", { runId: "run-1" })
      logEvent("run-1", "step.started", { runId: "run-1", step: "build" })
      logEvent("run-1", "step.started", { runId: "run-1", step: "build" })
      logEvent("run-1", "pipeline.success", { runId: "run-1" })

      const counts = countEvents("run-1")
      expect(counts["pipeline.started"]).toBe(1)
      expect(counts["step.started"]).toBe(2)
      expect(counts["pipeline.success"]).toBe(1)
    })

    it("returns empty object for unknown runId", () => {
      expect(countEvents("unknown")).toEqual({})
    })
  })
})

// ─── action-state Tests ────────────────────────────────────────────────────────

describe("action-state", () => {
  beforeEach(async () => {
    const actionState = await import("../../src/event-system/store/action-state.js")
    const setter = actionState._setDataDir as (dir: string | null) => void
    setter(tmpDir)
    upsertActionState = actionState.upsertActionState
    pollInstruction = actionState.pollInstruction
    enqueueInstruction = actionState.enqueueInstruction
    getActionState = actionState.getActionState
    listActionStates = actionState.listActionStates
    deleteActionState = actionState.deleteActionState
    isActionStale = actionState.isActionStale
    expireStaleActions = actionState.expireStaleActions
  })

  describe("upsertActionState", () => {
    it("creates a new action state", () => {
      const state = upsertActionState({
        runId: "action-1",
        actionId: "act-1",
        status: "running",
        step: "build",
      })

      expect(state.runId).toBe("action-1")
      expect(state.actionId).toBe("act-1")
      expect(state.status).toBe("running")
      expect(state.step).toBe("build")
      expect(state.lastHeartbeat).toBeTruthy()
      expect(state.createdAt).toBeTruthy()
    })

    it("updates an existing state", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1", status: "running", step: "build" })
      const updated = upsertActionState({
        runId: "action-1",
        actionId: "act-1",
        status: "waiting",
        step: "review",
      })

      expect(updated.status).toBe("waiting")
      expect(updated.step).toBe("review")
    })

    it("rejects update with wrong actionId", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1", status: "running" })
      const result = upsertActionState({
        runId: "action-1",
        actionId: "wrong-id",
        status: "waiting",
      })
      expect(result).toBeNull()
    })
  })

  describe("pollInstruction", () => {
    it("returns null instruction when no state exists", () => {
      const result = pollInstruction("unknown", "caller-1")
      expect(result.instruction).toBeNull()
      expect(result.cancel).toBe(false)
    })

    it("pops instructions FIFO and persists the removal", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1", status: "running" })
      enqueueInstruction("action-1", "fix the build")
      enqueueInstruction("action-1", "write a test")

      const first = pollInstruction("action-1", "act-1")
      expect(first.instruction).toBe("fix the build")

      const second = pollInstruction("action-1", "act-1")
      expect(second.instruction).toBe("write a test")

      // Verify queue was persisted as empty
      const state = getActionState("action-1")
      expect(state?.instructions).toHaveLength(0)
    })

    it("returns cancel flag from state", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1", status: "running" })
      upsertActionState({
        runId: "action-1",
        actionId: "act-1",
        cancel: true,
        cancelledBy: "user",
      })

      const result = pollInstruction("action-1", "act-1")
      expect(result.cancel).toBe(true)
      expect(result.cancelledBy).toBe("user")
    })
  })

  describe("enqueueInstruction", () => {
    it("returns false when no state exists", () => {
      expect(enqueueInstruction("unknown", "do something")).toBe(false)
    })

    it("appends instruction to queue", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1" })
      enqueueInstruction("action-1", "hello")

      const state = getActionState("action-1")
      expect(state?.instructions).toEqual(["hello"])
    })
  })

  describe("getActionState", () => {
    it("returns null for unknown runId", () => {
      expect(getActionState("unknown")).toBeNull()
    })

    it("returns the stored state", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1", status: "waiting", step: "test" })
      const state = getActionState("action-1")
      expect(state?.status).toBe("waiting")
      expect(state?.step).toBe("test")
    })
  })

  describe("listActionStates", () => {
    it("lists all states", () => {
      upsertActionState({ runId: "a", actionId: "a", status: "running" })
      upsertActionState({ runId: "b", actionId: "b", status: "running" })
      expect(listActionStates()).toHaveLength(2)
    })

    it("filters by sessionId", () => {
      upsertActionState({ runId: "a", actionId: "a", sessionId: "sess-1" })
      upsertActionState({ runId: "b", actionId: "b", sessionId: "sess-2" })
      upsertActionState({ runId: "c", actionId: "c" })

      expect(listActionStates("sess-1")).toHaveLength(1)
      expect(listActionStates("sess-2")).toHaveLength(1)
    })
  })

  describe("deleteActionState", () => {
    it("returns false for unknown runId", () => {
      expect(deleteActionState("unknown")).toBe(false)
    })

    it("removes the state", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1" })
      expect(deleteActionState("action-1")).toBe(true)
      expect(getActionState("action-1")).toBeNull()
    })
  })

  describe("isActionStale", () => {
    it("returns true for unknown runId", () => {
      expect(isActionStale("unknown")).toBe(true)
    })

    it("returns false for fresh state", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1" })
      expect(isActionStale("action-1", 60000)).toBe(false)
    })

    it("returns true for stale heartbeat", () => {
      upsertActionState({ runId: "action-1", actionId: "act-1" })
      // Manually backdate lastHeartbeat in the file
      const file = path.join(tmpDir, ".kody-engine/action-state.json")
      const content = JSON.parse(fs.readFileSync(file, "utf-8"))
      content[0].lastHeartbeat = new Date(Date.now() - 120000).toISOString()
      fs.writeFileSync(file, JSON.stringify(content))

      expect(isActionStale("action-1", 60000)).toBe(true)
    })
  })

  describe("expireStaleActions", () => {
    it("removes stale actions and returns their runIds", () => {
      upsertActionState({ runId: "fresh-1", actionId: "f1" })
      upsertActionState({ runId: "stale-1", actionId: "s1" })

      // Backdate stale action heartbeat
      const file = path.join(tmpDir, ".kody-engine/action-state.json")
      const content = JSON.parse(fs.readFileSync(file, "utf-8"))
      const stale = content.find((c: any) => c.runId === "stale-1")
      stale.lastHeartbeat = new Date(Date.now() - 120000).toISOString()
      fs.writeFileSync(file, JSON.stringify(content))

      const expired = expireStaleActions(60000)

      expect(expired).toEqual(["stale-1"])
      expect(getActionState("fresh-1")).not.toBeNull()
      expect(getActionState("stale-1")).toBeNull()
    })
  })
})

// ─── pr-state Tests ────────────────────────────────────────────────────────────

describe("pr-state", () => {
  beforeEach(async () => {
    const prState = await import("../../src/event-system/store/pr-state.js")
    const setter = prState._setDataDir as (dir: string | null) => void
    setter(tmpDir)
    upsertPRState = prState.upsertPRState
    markPRCreated = prState.markPRCreated
    markPRMerged = prState.markPRMerged
    getPRState = prState.getPRState
    getPRStatesBySession = prState.getPRStatesBySession
    getOpenPRsForSession = prState.getOpenPRsForSession
    listPRStates = prState.listPRStates
  })

  describe("upsertPRState", () => {
    it("creates a new PR state", () => {
      const pr = upsertPRState({
        runId: "pr-run-1",
        title: "Fix bug",
        body: "Fixes #42",
        head: "fix-42",
      })

      expect(pr.runId).toBe("pr-run-1")
      expect(pr.title).toBe("Fix bug")
      expect(pr.status).toBe("pending")
      expect(pr.createdAt).toBeTruthy()
    })

    it("updates an existing state", () => {
      upsertPRState({ runId: "pr-run-1", title: "Fix bug" })
      const updated = upsertPRState({ runId: "pr-run-1", title: "Fix bug v2", status: "open" })

      expect(updated.title).toBe("Fix bug v2")
      expect(updated.status).toBe("open")
    })
  })

  describe("markPRCreated", () => {
    it("updates status to open and sets prNumber/prUrl", () => {
      upsertPRState({ runId: "pr-run-1", title: "Fix bug", head: "fix-42" })
      const updated = markPRCreated("pr-run-1", 47, "https://github.com/org/repo/pull/47")

      expect(updated.status).toBe("open")
      expect(updated.prNumber).toBe(47)
      expect(updated.prUrl).toBe("https://github.com/org/repo/pull/47")
    })

    it("returns null for unknown runId", () => {
      expect(markPRCreated("unknown", 47, "url")).toBeNull()
    })
  })

  describe("markPRMerged", () => {
    it("updates status to merged and sets mergedAt", () => {
      upsertPRState({ runId: "pr-run-1", title: "Fix bug", status: "open" })
      const updated = markPRMerged("pr-run-1")

      expect(updated.status).toBe("merged")
      expect(updated.mergedAt).toBeTruthy()
    })

    it("returns null for unknown runId", () => {
      expect(markPRMerged("unknown")).toBeNull()
    })
  })

  describe("getPRState", () => {
    it("returns null for unknown runId", () => {
      expect(getPRState("unknown")).toBeNull()
    })

    it("returns the stored PR state", () => {
      upsertPRState({ runId: "pr-run-1", title: "Fix bug", status: "open" })
      const pr = getPRState("pr-run-1")
      expect(pr?.title).toBe("Fix bug")
    })
  })

  describe("getPRStatesBySession", () => {
    it("returns all PRs for a session", () => {
      upsertPRState({ runId: "pr-1", sessionId: "sess-1", title: "PR 1" })
      upsertPRState({ runId: "pr-2", sessionId: "sess-1", title: "PR 2" })
      upsertPRState({ runId: "pr-3", sessionId: "sess-2", title: "PR 3" })

      const prs = getPRStatesBySession("sess-1")
      expect(prs).toHaveLength(2)
    })
  })

  describe("getOpenPRsForSession", () => {
    it("returns only open PRs", () => {
      upsertPRState({ runId: "pr-1", sessionId: "sess-1", title: "Open", status: "open" })
      upsertPRState({ runId: "pr-2", sessionId: "sess-1", title: "Merged", status: "merged" })
      upsertPRState({ runId: "pr-3", sessionId: "sess-1", title: "Pending", status: "pending" })

      const open = getOpenPRsForSession("sess-1")
      expect(open).toHaveLength(1)
      expect(open[0].title).toBe("Open")
    })
  })

  describe("listPRStates", () => {
    it("lists all PR states", () => {
      upsertPRState({ runId: "pr-1", title: "One" })
      upsertPRState({ runId: "pr-2", title: "Two" })
      expect(listPRStates()).toHaveLength(2)
    })
  })
})
