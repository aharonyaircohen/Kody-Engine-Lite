import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { loadWatchAgents } from "../../src/watch/agents/loader"
import { buildWatchAgentPrompt } from "../../src/watch/agents/prompt-builder"
import { shouldRunOnCycle } from "../../src/watch/core/schedule"
import type { WatchAgentDefinition, StateStore } from "../../src/watch/core/types"

// ============================================================================
// Loader Tests
// ============================================================================

describe("loadWatchAgents", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-agents-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createAgent(name: string, json: unknown, md: string) {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify(json))
    fs.writeFileSync(path.join(agentDir, "agent.md"), md)
  }

  it("returns empty when agents directory does not exist", () => {
    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })

  it("loads valid agent with all fields", () => {
    createAgent("my-agent", {
      name: "my-agent",
      description: "Test agent",
      schedule: { everyHours: 48 },
    }, "Check open PRs for staleness.")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(warnings).toHaveLength(0)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.name).toBe("my-agent")
    expect(agents[0].config.description).toBe("Test agent")
    expect(agents[0].config.schedule.everyHours).toBe(48)
    expect(agents[0].systemPrompt).toBe("Check open PRs for staleness.")
  })

  it("defaults schedule.every to 1 when omitted", () => {
    createAgent("no-schedule", {
      name: "no-schedule",
      description: "Runs every cycle",
    }, "Do something every cycle.")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.schedule.everyHours).toBe(1)
  })

  it("parses reportOnFailure when true", () => {
    createAgent("report-agent", {
      name: "report-agent",
      description: "Reports on failure",
      reportOnFailure: true,
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.reportOnFailure).toBe(true)
  })

  it("defaults reportOnFailure to false when omitted", () => {
    createAgent("no-report", {
      name: "no-report",
      description: "No reporting",
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.reportOnFailure).toBe(false)
  })

  it("defaults reportOnFailure to false when set to non-true value", () => {
    createAgent("bad-report", {
      name: "bad-report",
      description: "Bad value",
      reportOnFailure: "yes",
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.reportOnFailure).toBe(false)
  })

  it("parses timeoutMs when valid positive number", () => {
    createAgent("timeout-agent", {
      name: "timeout-agent",
      description: "Custom timeout",
      timeoutMs: 3600000,
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.timeoutMs).toBe(3600000)
  })

  it("defaults timeoutMs to undefined when omitted", () => {
    createAgent("no-timeout", {
      name: "no-timeout",
      description: "Default timeout",
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.timeoutMs).toBeUndefined()
  })

  it("ignores timeoutMs when zero or negative", () => {
    createAgent("zero-timeout", {
      name: "zero-timeout",
      description: "Bad timeout",
      timeoutMs: 0,
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.timeoutMs).toBeUndefined()
  })

  it("ignores timeoutMs when non-number", () => {
    createAgent("string-timeout", {
      name: "string-timeout",
      description: "Bad timeout",
      timeoutMs: "fast",
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.timeoutMs).toBeUndefined()
  })

  it("skips directory missing agent.json", () => {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", "no-json")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.md"), "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("missing agent.json")
  })

  it("skips directory missing agent.md", () => {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", "no-md")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify({
      name: "no-md", description: "Test", schedule: { everyHours: 1 },
    }))

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("missing agent.md")
  })

  it("skips directory with invalid JSON", () => {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", "bad-json")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.json"), "not json{{{")
    fs.writeFileSync(path.join(agentDir, "agent.md"), "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("invalid JSON")
  })

  it("skips agent with missing name", () => {
    createAgent("missing-name", {
      description: "No name",
      schedule: { everyHours: 1 },
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"name"')
  })

  it("skips agent with missing description", () => {
    createAgent("missing-desc", {
      name: "missing-desc",
      schedule: { everyHours: 1 },
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"description"')
  })

  it("rejects schedule.every < 1", () => {
    createAgent("bad-schedule", {
      name: "bad-schedule",
      description: "Test",
      schedule: { everyHours: 0 },
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("schedule.everyHours")
  })

  it("rejects non-integer schedule.every", () => {
    createAgent("float-schedule", {
      name: "float-schedule",
      description: "Test",
      schedule: { everyHours: 1.5 },
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
  })

  it("skips empty agent.md", () => {
    createAgent("empty-md", {
      name: "empty-md",
      description: "Test",
    }, "   ")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("empty")
  })

  it("loads multiple valid agents", () => {
    createAgent("agent-a", { name: "agent-a", description: "A" }, "Prompt A")
    createAgent("agent-b", { name: "agent-b", description: "B", schedule: { everyHours: 10 } }, "Prompt B")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(warnings).toHaveLength(0)
    expect(agents).toHaveLength(2)
    const names = agents.map((a) => a.config.name).sort()
    expect(names).toEqual(["agent-a", "agent-b"])
  })

  it("ignores non-directory entries", () => {
    const agentsDir = path.join(tmpDir, ".kody", "watch", "agents")
    fs.mkdirSync(agentsDir, { recursive: true })
    fs.writeFileSync(path.join(agentsDir, "README.md"), "ignore me")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })
})

// ============================================================================
// Prompt Builder Tests
// ============================================================================

describe("buildWatchAgentPrompt", () => {
  const agent: WatchAgentDefinition = {
    config: {
      name: "test-agent",
      description: "A test watch agent",
      schedule: { everyHours: 1 },
    },
    systemPrompt: "List open PRs and flag stale ones.",
    dirPath: "/tmp/test-agent",
  }

  it("includes repo name", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 5 })
    expect(prompt).toContain("owner/repo")
  })

  it("includes cycle number", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 42 })
    expect(prompt).toContain("42")
  })

  it("includes agent system prompt", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).toContain("List open PRs and flag stale ones.")
  })

  it("includes gh CLI examples", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).toContain("gh pr list")
    expect(prompt).toContain("gh issue create")
  })

  it("includes dedup guideline", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).toContain("Check before creating")
  })

  it("includes label guideline", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).toContain("kody:watch:")
  })

  it("includes activity log when provided", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1, activityLog: 99 })
    expect(prompt).toContain("#99")
  })

  it("omits activity log when not provided", () => {
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).not.toContain("Activity log")
  })
})

// ============================================================================
// Agent Schedule Filtering Tests — uses shouldRunOnCycle
// ============================================================================

describe("agent schedule filtering via shouldRunOnCycle", () => {
  let state: StateStore

  beforeEach(() => {
    const data = new Map<string, unknown>()
    state = {
      get: <T>(key: string) => data.get(key) as T | undefined,
      set: <T>(key: string, value: T) => { data.set(key, value) },
      save: () => {},
    }
  })

  it("runs agent when cycle matches schedule.everyHours", () => {
    const schedule = { everyHours: 48 }
    expect(shouldRunOnCycle(schedule, 48, state, new Date())).toBe(true)
    expect(shouldRunOnCycle(schedule, 96, state, new Date())).toBe(true)
  })

  it("skips agent when cycle does not match everyHours", () => {
    const schedule = { everyHours: 48 }
    expect(shouldRunOnCycle(schedule, 1, state, new Date())).toBe(false)
    expect(shouldRunOnCycle(schedule, 47, state, new Date())).toBe(false)
  })

  it("runs every-1 agent on every cycle", () => {
    const schedule = { every: 1 }
    for (let cycle = 1; cycle <= 10; cycle++) {
      expect(shouldRunOnCycle(schedule, cycle, state, new Date())).toBe(true)
    }
  })

  it("runs agent with runAt when within cron window", () => {
    // Schedule at 02:00, run at 02:10 (within 30-min window)
    // Use UTC dates so getUTCHours() matches the expected hour
    const schedule = { runAt: "02:00" }
    const runAt = new Date("2026-04-08T02:10:00Z")
    expect(shouldRunOnCycle(schedule, 1, state, runAt)).toBe(true)
  })

  it("skips agent with runAt when outside cron window", () => {
    // Schedule at 02:00, run at 03:15 (outside 30-min window)
    const schedule = { runAt: "02:00" }
    const runAt = new Date("2026-04-08T03:15:00Z")
    expect(shouldRunOnCycle(schedule, 1, state, runAt)).toBe(false)
  })

  it("skips runAt agent when not enough days have passed", () => {
    // Schedule: run at 02:00, every 7 days
    const schedule = { runAt: "02:00", days: 7 }
    const runAt = new Date("2026-04-08T02:10:00Z")

    // First run should succeed
    expect(shouldRunOnCycle(schedule, 1, state, runAt)).toBe(true)

    // Second run 1 day later should be skipped (not enough days)
    const oneDayLater = new Date("2026-04-09T02:10:00Z")
    expect(shouldRunOnCycle(schedule, 2, state, oneDayLater)).toBe(false)
  })

  it("allows runAt agent after days interval has passed", () => {
    const schedule = { runAt: "02:00", days: 1 }
    const runAt = new Date("2026-04-08T02:10:00Z")

    // First run
    expect(shouldRunOnCycle(schedule, 1, state, runAt)).toBe(true)

    // Next cycle > 12 hours later (within 30-min window next day)
    const nextDay = new Date("2026-04-09T02:10:00Z")
    expect(shouldRunOnCycle(schedule, 2, state, nextDay)).toBe(true)
  })
})

// ============================================================================
// Loader — runAt and days preservation
// ============================================================================

describe("loadWatchAgents preserves runAt and days", () => {
  let tmpDir: string
  let fs: typeof import("fs")
  let path: typeof import("path")

  beforeEach(async () => {
    ;({ default: fs } = await import("fs"))
    ;({ default: path } = await import("path"))
    tmpDir = fs.mkdtempSync(path.join(await import("os").then((m) => m.tmpdir()), "watch-runat-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createAgent(name: string, json: unknown) {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify(json))
    fs.writeFileSync(path.join(agentDir, "agent.md"), "Test prompt.")
  }

  it("preserves runAt from schedule config", () => {
    createAgent("bench-agent", {
      name: "bench-agent",
      description: "Memory benchmark",
      schedule: { runAt: "04:00", days: 7 },
    })

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.schedule.runAt).toBe("04:00")
    expect(agents[0].config.schedule.days).toBe(7)
    expect(agents[0].config.schedule.everyHours).toBe(1) // default
  })

  it("preserves runAt and days without every", () => {
    createAgent("test-agent", {
      name: "test-agent",
      description: "Test suite",
      schedule: { runAt: "02:00", days: 1 },
    })

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.schedule.runAt).toBe("02:00")
    expect(agents[0].config.schedule.days).toBe(1)
    expect(agents[0].config.schedule.everyHours).toBe(1)
  })

  it("omits runAt from config when not provided", () => {
    createAgent("simple-agent", {
      name: "simple-agent",
      description: "Simple agent",
      schedule: { everyHours: 3 },
    })

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.schedule.runAt).toBeUndefined()
    expect(agents[0].config.schedule.everyHours).toBe(3)
  })

  it("ignores invalid runAt (empty string)", () => {
    createAgent("bad-runat", {
      name: "bad-runat",
      description: "Bad",
      schedule: { runAt: "", days: 1 },
    })

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.schedule.runAt).toBeUndefined()
    expect(agents[0].config.schedule.days).toBe(1)
  })

  it("ignores non-integer days", () => {
    createAgent("float-days", {
      name: "float-days",
      description: "Bad days",
      schedule: { runAt: "05:00", days: 1.5 },
    })

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.schedule.days).toBeUndefined()
  })
})
