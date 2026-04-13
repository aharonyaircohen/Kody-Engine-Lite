import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { loadWatchAgents } from "../../src/watch/agents/loader"
import { buildWatchAgentPrompt } from "../../src/watch/agents/prompt-builder"
import { cronMatches } from "../../src/watch/core/schedule"
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
      cron: "0 9 * * 1",
    }, "Check open PRs for staleness.")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(warnings).toHaveLength(0)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.name).toBe("my-agent")
    expect(agents[0].config.description).toBe("Test agent")
    expect(agents[0].config.cron).toBe("0 9 * * 1")
    expect(agents[0].systemPrompt).toBe("Check open PRs for staleness.")
  })

  it("parses reportOnFailure when true", () => {
    createAgent("report-agent", {
      name: "report-agent",
      description: "Reports on failure",
      cron: "0 9 * * 1",
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
      cron: "0 9 * * 1",
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.reportOnFailure).toBe(false)
  })

  it("parses timeoutMs when valid positive number", () => {
    createAgent("timeout-agent", {
      name: "timeout-agent",
      description: "Custom timeout",
      cron: "0 9 * * 1",
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
      cron: "0 9 * * 1",
    }, "Some prompt")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.timeoutMs).toBeUndefined()
  })

  it("ignores timeoutMs when zero or negative", () => {
    createAgent("zero-timeout", {
      name: "zero-timeout",
      description: "Bad timeout",
      cron: "0 9 * * 1",
      timeoutMs: 0,
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
      name: "no-md", description: "Test", cron: "0 9 * * 1",
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
      cron: "0 9 * * 1",
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"name"')
  })

  it("skips agent with missing description", () => {
    createAgent("missing-desc", {
      name: "missing-desc",
      cron: "0 9 * * 1",
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"description"')
  })

  it("skips agent with missing cron", () => {
    createAgent("no-cron", {
      name: "no-cron",
      description: "No cron expression",
    }, "Some prompt")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"cron"')
  })

  it("skips empty agent.md", () => {
    createAgent("empty-md", {
      name: "empty-md",
      description: "Test",
      cron: "0 9 * * 1",
    }, "   ")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("empty")
  })

  it("loads multiple valid agents", () => {
    createAgent("agent-a", { name: "agent-a", description: "A", cron: "0 9 * * 1" }, "Prompt A")
    createAgent("agent-b", { name: "agent-b", description: "B", cron: "0 10 * * 0" }, "Prompt B")

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
// dead-code-cleanup Agent Tests
// ============================================================================

describe("dead-code-cleanup agent", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dead-code-cleanup-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createAgent(json: unknown, md: string) {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", "dead-code-cleanup")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify(json))
    fs.writeFileSync(path.join(agentDir, "agent.md"), md)
  }

  it("loads agent with cron field", () => {
    createAgent({
      name: "dead-code-cleanup",
      description: "Scans for unused exports, dead files, and unreachable code",
      cron: "0 9 * * 1",
    }, "Scan for dead code.")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(warnings).toHaveLength(0)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.name).toBe("dead-code-cleanup")
    expect(agents[0].config.description).toBe("Scans for unused exports, dead files, and unreachable code")
    expect(agents[0].config.cron).toBe("0 9 * * 1")
  })

  it("parses reportOnFailure when true", () => {
    createAgent({
      name: "dead-code-cleanup",
      description: "Scans for dead code",
      cron: "0 9 * * 1",
      reportOnFailure: true,
    }, "Scan for dead code.")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.reportOnFailure).toBe(true)
  })

  it("parses timeoutMs when valid positive number", () => {
    createAgent({
      name: "dead-code-cleanup",
      description: "Scans for dead code",
      cron: "0 9 * * 1",
      timeoutMs: 3600000,
    }, "Scan for dead code.")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.timeoutMs).toBe(3600000)
  })
})

// ============================================================================
// release-publisher Agent Tests
// ============================================================================

describe("release-publisher agent", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-publisher-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createAgent(json: unknown, md: string) {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", "release-publisher")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify(json))
    fs.writeFileSync(path.join(agentDir, "agent.md"), md)
  }

  it("loads agent with all required fields", () => {
    createAgent({
      name: "release-publisher",
      description: "Creates a release tracking issue and runs @kody release to open a release PR",
      cron: "0 10 * * 1",
    }, "Create release issue and run @kody release.")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    expect(warnings).toHaveLength(0)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.name).toBe("release-publisher")
    expect(agents[0].config.description).toBe("Creates a release tracking issue and runs @kody release to open a release PR")
    expect(agents[0].config.cron).toBe("0 10 * * 1")
  })

  it("parses reportOnFailure when true", () => {
    createAgent({
      name: "release-publisher",
      description: "Creates release issues",
      cron: "0 10 * * 1",
      reportOnFailure: true,
    }, "Create release issue.")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.reportOnFailure).toBe(true)
  })

  it("defaults reportOnFailure to false when omitted", () => {
    createAgent({
      name: "release-publisher",
      description: "Creates release issues",
      cron: "0 10 * * 1",
    }, "Create release issue.")

    const { agents } = loadWatchAgents(tmpDir)
    expect(agents).toHaveLength(1)
    expect(agents[0].config.reportOnFailure).toBe(false)
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
      cron: "0 9 * * 1",
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
// cronMatches Tests
// ============================================================================

describe("cronMatches", () => {
  it("matches daily cron at 09:00 within the 30-min window", () => {
    const now = new Date("2026-04-13T09:10:00Z")
    expect(cronMatches("0 9 * * *", now)).toBe(true)
  })

  it("matches weekly cron on Monday at 09:00 within the 30-min window", () => {
    // April 13 2026 is a Monday
    const now = new Date("2026-04-13T09:00:00Z")
    expect(cronMatches("0 9 * * 1", now)).toBe(true)
  })

  it("does not match when outside the 30-min window", () => {
    const now = new Date("2026-04-13T10:00:00Z")
    expect(cronMatches("0 9 * * *", now)).toBe(false)
  })

  it("does not match on a non-matching day of week", () => {
    // April 13 2026 is a Monday
    const now = new Date("2026-04-14T09:05:00Z") // Tuesday
    expect(cronMatches("0 9 * * 1", now)).toBe(false)
  })

  it("returns false for invalid cron", () => {
    const now = new Date("2026-04-13T09:00:00Z")
    expect(cronMatches("not a cron", now)).toBe(false)
  })
})
