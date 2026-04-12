import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"

import { loadWatchAgents } from "../../src/watch/agents/loader"
import { buildWatchAgentPrompt } from "../../src/watch/agents/prompt-builder"
import type { WatchAgentDefinition } from "../../src/watch/core/types"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "../..")

// ============================================================================
// Loader Tests — skill-opportunity-hunter from templates
// ============================================================================

describe("skill-opportunity-hunter agent", () => {
  const templatesDir = path.join(rootDir, "templates", "watch-agents")
  const agentDir = path.join(templatesDir, "skill-opportunity-hunter")

  it("agent.json exists in templates", () => {
    expect(fs.existsSync(path.join(agentDir, "agent.json"))).toBe(true)
  })

  it("agent.md exists in templates", () => {
    expect(fs.existsSync(path.join(agentDir, "agent.md"))).toBe(true)
  })

  it("agent.json has correct name", () => {
    const raw = fs.readFileSync(path.join(agentDir, "agent.json"), "utf-8")
    const config = JSON.parse(raw)
    expect(config.name).toBe("skill-opportunity-hunter")
  })

  it("agent.json has cron schedule", () => {
    const raw = fs.readFileSync(path.join(agentDir, "agent.json"), "utf-8")
    const config = JSON.parse(raw)
    expect(typeof config.cron).toBe("string")
    expect(config.cron.length).toBeGreaterThan(0)
  })

  it("agent.json has required description", () => {
    const raw = fs.readFileSync(path.join(agentDir, "agent.json"), "utf-8")
    const config = JSON.parse(raw)
    expect(typeof config.description).toBe("string")
    expect(config.description.length).toBeGreaterThan(0)
  })

  it("agent.md is non-empty", () => {
    const md = fs.readFileSync(path.join(agentDir, "agent.md"), "utf-8")
    expect(md.trim().length).toBeGreaterThan(0)
  })

  it("agent.md contains pattern detection instructions", () => {
    const md = fs.readFileSync(path.join(agentDir, "agent.md"), "utf-8")
    const signals = [
      "scripts/",
      "docker-compose",
      "package.json",
      "fetch",
      "axios",
    ]
    const found = signals.filter((s) => md.includes(s))
    expect(found.length).toBeGreaterThanOrEqual(3)
  })

  it("agent.md contains issue creation instructions", () => {
    const md = fs.readFileSync(path.join(agentDir, "agent.md"), "utf-8")
    expect(md.includes("kody:watch:skill-opportunity")).toBe(true)
    expect(md.includes("gh issue create")).toBe(true)
  })

  it("agent.md contains confidence rating", () => {
    const md = fs.readFileSync(path.join(agentDir, "agent.md"), "utf-8")
    expect(md.includes("Confidence")).toBe(true)
    expect(md.includes("High")).toBe(true)
    expect(md.includes("Medium")).toBe(true)
    expect(md.includes("Low")).toBe(true)
  })

  it("agent.md contains deduplication instructions", () => {
    const md = fs.readFileSync(path.join(agentDir, "agent.md"), "utf-8")
    expect(md.includes("Check for duplicates") || md.includes("duplicate")).toBe(true)
  })

  it("agent.md contains skill scaffold suggestion", () => {
    const md = fs.readFileSync(path.join(agentDir, "agent.md"), "utf-8")
    expect(md.includes("skill.json")).toBe(true)
    expect(md.includes(".kody/skills/")).toBe(true)
  })
})

// ============================================================================
// Prompt Builder Tests
// ============================================================================

describe("buildWatchAgentPrompt — skill-opportunity-hunter", () => {
  const agentDir = path.join(rootDir, "templates", "watch-agents", "skill-opportunity-hunter")

  function loadAgent(): WatchAgentDefinition {
    const config = JSON.parse(fs.readFileSync(path.join(agentDir, "agent.json"), "utf-8"))
    const systemPrompt = fs.readFileSync(path.join(agentDir, "agent.md"), "utf-8")
    return {
      config,
      systemPrompt,
      dirPath: agentDir,
    }
  }

  it("includes repo name", () => {
    const agent = loadAgent()
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).toContain("owner/repo")
  })

  it("includes cycle number", () => {
    const agent = loadAgent()
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 42 })
    expect(prompt).toContain("42")
  })

  it("includes the agent system prompt", () => {
    const agent = loadAgent()
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).toContain("skill-opportunity-hunter")
  })

  it("includes gh CLI examples", () => {
    const agent = loadAgent()
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).toContain("gh issue list") || expect(prompt).toContain("gh issue")
  })

  it("includes activity log when provided", () => {
    const agent = loadAgent()
    const prompt = buildWatchAgentPrompt(agent, {
      repo: "owner/repo",
      cycleNumber: 1,
      activityLog: 99,
    })
    expect(prompt).toContain("#99")
  })

  it("omits activity log when not provided", () => {
    const agent = loadAgent()
    const prompt = buildWatchAgentPrompt(agent, { repo: "owner/repo", cycleNumber: 1 })
    expect(prompt).not.toContain("Activity log")
  })
})

// ============================================================================
// Loader integration — agent loads correctly via loadWatchAgents
// ============================================================================

describe("loadWatchAgents — skill-opportunity-hunter", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hunter-loader-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("loadWatchAgents loads skill-opportunity-hunter from .kody/watch/agents/", () => {
    // loadWatchAgents expects agents at <projectDir>/.kody/watch/agents/<name>/
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", "skill-opportunity-hunter")
    fs.mkdirSync(agentDir, { recursive: true })

    const templatesAgentDir = path.join(rootDir, "templates", "watch-agents", "skill-opportunity-hunter")
    fs.copyFileSync(
      path.join(templatesAgentDir, "agent.json"),
      path.join(agentDir, "agent.json"),
    )
    fs.copyFileSync(
      path.join(templatesAgentDir, "agent.md"),
      path.join(agentDir, "agent.md"),
    )

    const { agents, warnings } = loadWatchAgents(tmpDir)
    const skillHunter = agents.find((a) => a.config.name === "skill-opportunity-hunter")
    expect(skillHunter).toBeDefined()
    expect(skillHunter!.config.description.toLowerCase()).toContain("scans the codebase")
    expect(warnings).toHaveLength(0)
  })

  it("skips when agent.json is missing", () => {
    const agentDir = path.join(tmpDir, ".kody", "watch", "agents", "skill-opportunity-hunter")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "agent.md"), "Some prompt.")

    const { agents, warnings } = loadWatchAgents(tmpDir)
    const skillHunter = agents.find((a) => a.config.name === "skill-opportunity-hunter")
    expect(skillHunter).toBeUndefined()
    expect(warnings.some((w) => w.includes("missing agent.json"))).toBe(true)
  })
})
