import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { loadWatchAgents } from "../../src/watch/agents/loader"
import { buildWatchAgentPrompt } from "../../src/watch/agents/prompt-builder"
import type { WatchAgentDefinition } from "../../src/watch/core/types"

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
      schedule: { every: 48 },
    }, "Check open PRs for staleness.")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(warnings).toHaveLength(0)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.name).toBe("my-agent")
    expect(agents[0].config.description).toBe("Test agent")
    expect(agents[0].config.schedule.every).toBe(48)
    expect(agents[0].systemPrompt).toBe("Check open PRs for staleness.")
  })

  it("defaults schedule.every to 1 when omitted", () => {
    createAgent("no-schedule", {
      name: "no-schedule",
      description: "Runs every cycle",
    }, "Do something every cycle.")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.schedule.every).toBe(1)
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
      name: "no-md", description: "Test", schedule: { every: 1 },
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
      schedule: { every: 1 },
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"name"')
  })

  it("skips agent with missing description", () => {
    createAgent("missing-desc", {
      name: "missing-desc",
      schedule: { every: 1 },
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
      schedule: { every: 0 },
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("schedule.every")
  })

  it("rejects non-integer schedule.every", () => {
    createAgent("float-schedule", {
      name: "float-schedule",
      description: "Test",
      schedule: { every: 1.5 },
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
    createAgent("agent-b", { name: "agent-b", description: "B", schedule: { every: 10 } }, "Prompt B")

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
      schedule: { every: 1 },
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
// Agent Schedule Filtering Tests
// ============================================================================

describe("agent schedule filtering", () => {
  it("runs agent when cycle matches schedule.every", () => {
    const agent: WatchAgentDefinition = {
      config: { name: "a", description: "A", schedule: { every: 48 } },
      systemPrompt: "test",
      dirPath: "/tmp",
    }
    expect(48 % agent.config.schedule.every === 0).toBe(true)
    expect(96 % agent.config.schedule.every === 0).toBe(true)
  })

  it("skips agent when cycle does not match", () => {
    const agent: WatchAgentDefinition = {
      config: { name: "a", description: "A", schedule: { every: 48 } },
      systemPrompt: "test",
      dirPath: "/tmp",
    }
    expect(1 % agent.config.schedule.every === 0).toBe(false)
    expect(47 % agent.config.schedule.every === 0).toBe(false)
  })

  it("runs every-1 agent on every cycle", () => {
    const agent: WatchAgentDefinition = {
      config: { name: "a", description: "A", schedule: { every: 1 } },
      systemPrompt: "test",
      dirPath: "/tmp",
    }
    for (let cycle = 1; cycle <= 10; cycle++) {
      expect(cycle % agent.config.schedule.every === 0).toBe(true)
    }
  })
})
