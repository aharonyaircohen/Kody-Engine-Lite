import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

vi.mock("../../src/watch/agents/run-agent", () => ({
  runWatchAgent: vi.fn(),
}))

vi.mock("../../src/watch/clients/github", () => ({
  createGitHubClient: vi.fn(),
}))

vi.mock("../../src/watch/clients/logger", () => ({
  createConsoleLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

import { runWatch } from "../../src/watch/core/watch"
import { runWatchAgent } from "../../src/watch/agents/run-agent"
import { createGitHubClient } from "../../src/watch/clients/github"
import type { WatchConfig, WatchAgentRunResult } from "../../src/watch/core/types"

const mockRunWatchAgent = vi.mocked(runWatchAgent)
const mockCreateGitHubClient = vi.mocked(createGitHubClient)

let tmpDir: string

function makeConfig(overrides?: Partial<WatchConfig>): WatchConfig {
  return {
    repo: "test/repo",
    dryRun: false,
    stateFile: path.join(tmpDir, "watch-state.json"),
    plugins: [],
    activityLog: 42,
    agents: [],
    model: "test-model",
    provider: "claude",
    projectDir: "/tmp/test",
    ...overrides,
  }
}

describe("watch orchestrator — reportOnFailure", () => {
  let postComment: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-orch-test-"))
    postComment = vi.fn()
    mockCreateGitHubClient.mockReturnValue({
      postComment,
      getIssue: () => ({ body: null, title: null }),
      getIssueComments: () => [],
      updateComment: () => {},
      getOpenIssues: () => [],
      createIssue: () => null,
      searchIssues: () => [],
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("posts fallback comment when agent fails and reportOnFailure is true", async () => {
    const failResult: WatchAgentRunResult = {
      agentName: "test-agent",
      outcome: "failed",
      error: "Exit code 1",
    }
    mockRunWatchAgent.mockResolvedValue(failResult)

    const config = makeConfig({
      agents: [{
        config: { name: "test-agent", description: "Test", cron: "* * * * *", reportOnFailure: true },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Watch Agent: test-agent — failed"),
    )
    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Exit code 1"),
    )
  })

  it("posts fallback with output in details tag when agent times out", async () => {
    const timeoutResult: WatchAgentRunResult = {
      agentName: "slow-agent",
      outcome: "timed_out",
      output: "partial output from agent",
    }
    mockRunWatchAgent.mockResolvedValue(timeoutResult)

    const config = makeConfig({
      agents: [{
        config: { name: "slow-agent", description: "Slow", cron: "* * * * *", reportOnFailure: true },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Watch Agent: slow-agent — timed_out"),
    )
    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("<details>"),
    )
    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("partial output from agent"),
    )
  })

  it("does NOT post fallback when agent completes successfully", async () => {
    const successResult: WatchAgentRunResult = {
      agentName: "good-agent",
      outcome: "completed",
      output: "all good",
    }
    mockRunWatchAgent.mockResolvedValue(successResult)

    const config = makeConfig({
      agents: [{
        config: { name: "good-agent", description: "Good", cron: "* * * * *", reportOnFailure: true },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    const result = await runWatch(config)

    // postComment is only called for state persistence, not for fallback
    const fallbackCalls = postComment.mock.calls.filter(
      (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("Watch Agent:"),
    )
    expect(fallbackCalls).toHaveLength(0)
    expect(result.agentResults[0].outcome).toBe("completed")
  })

  it("does NOT post fallback when reportOnFailure is false", async () => {
    const failResult: WatchAgentRunResult = {
      agentName: "quiet-agent",
      outcome: "failed",
      error: "something broke",
    }
    mockRunWatchAgent.mockResolvedValue(failResult)

    const config = makeConfig({
      agents: [{
        config: { name: "quiet-agent", description: "Quiet", cron: "* * * * *", reportOnFailure: false },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    const fallbackCalls = postComment.mock.calls.filter(
      (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("Watch Agent:"),
    )
    expect(fallbackCalls).toHaveLength(0)
  })

  it("does NOT post fallback when activityLog is not set", async () => {
    const failResult: WatchAgentRunResult = {
      agentName: "no-log-agent",
      outcome: "failed",
      error: "broke",
    }
    mockRunWatchAgent.mockResolvedValue(failResult)

    const config = makeConfig({
      activityLog: undefined,
      agents: [{
        config: { name: "no-log-agent", description: "No log", cron: "* * * * *", reportOnFailure: true },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    const fallbackCalls = postComment.mock.calls.filter(
      (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("Watch Agent:"),
    )
    expect(fallbackCalls).toHaveLength(0)
  })

  it("truncates output to 60000 chars in fallback comment", async () => {
    const longOutput = "x".repeat(70000)
    const result: WatchAgentRunResult = {
      agentName: "verbose-agent",
      outcome: "failed",
      output: longOutput,
    }
    mockRunWatchAgent.mockResolvedValue(result)

    const config = makeConfig({
      agents: [{
        config: { name: "verbose-agent", description: "Verbose", cron: "* * * * *", reportOnFailure: true },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    const fallbackCalls = postComment.mock.calls.filter(
      (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("Watch Agent:"),
    )
    expect(fallbackCalls).toHaveLength(1)
    const body = fallbackCalls[0][1] as string
    // Output should be truncated — full body should not contain all 70000 x's
    expect(body.length).toBeLessThan(65000)
  })

  it("continues running other agents when fallback posting fails", async () => {
    postComment.mockImplementation((issueNum: number, body: string) => {
      if (typeof body === "string" && body.includes("Watch Agent:")) {
        throw new Error("GitHub API error")
      }
    })

    const failResult: WatchAgentRunResult = {
      agentName: "agent-1",
      outcome: "failed",
      error: "broke",
    }
    const successResult: WatchAgentRunResult = {
      agentName: "agent-2",
      outcome: "completed",
    }
    mockRunWatchAgent
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(successResult)

    const config = makeConfig({
      agents: [
        {
          config: { name: "agent-1", description: "A1", cron: "* * * * *", reportOnFailure: true },
          systemPrompt: "test",
          dirPath: "/tmp",
        },
        {
          config: { name: "agent-2", description: "A2", cron: "* * * * *", },
          systemPrompt: "test",
          dirPath: "/tmp",
        },
      ],
    })

    const watchResult = await runWatch(config)

    expect(watchResult.agentResults).toHaveLength(2)
    expect(watchResult.agentResults[1].outcome).toBe("completed")
  })

  it("passes timeoutMs from agent config to runner", async () => {
    mockRunWatchAgent.mockResolvedValue({
      agentName: "custom-timeout",
      outcome: "completed",
    })

    const config = makeConfig({
      agents: [{
        config: { name: "custom-timeout", description: "Custom", cron: "* * * * *", timeoutMs: 3600000 },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(mockRunWatchAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 3600000 }),
    )
  })

  it("passes undefined timeoutMs when not configured", async () => {
    mockRunWatchAgent.mockResolvedValue({
      agentName: "default-timeout",
      outcome: "completed",
    })

    const config = makeConfig({
      agents: [{
        config: { name: "default-timeout", description: "Default", cron: "* * * * *", },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(mockRunWatchAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: undefined }),
    )
  })
})
