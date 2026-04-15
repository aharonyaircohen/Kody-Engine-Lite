import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execSync as realExecSync } from "child_process"

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn<(...args: Parameters<typeof realExecSync>) => void>(),
}))

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

vi.mock("child_process", () => ({
  execSync: mockExecSync,
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

// ============================================================================
// notify hook
// ============================================================================

describe("watch orchestrator — notify", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-orch-test-"))
    mockCreateGitHubClient.mockReturnValue({
      postComment: () => {},
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

  it("calls execSync with correct args when notify is configured and agent completes", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "notify-agent", outcome: "completed" })
    const config = makeConfig({
      projectDir: "/project/root",
      agents: [{
        config: {
          name: "notify-agent",
          description: "Test",
          cron: "* * * * *",
          notify: { channels: ["slack"], color: "good", when: "always" },
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(mockExecSync).toHaveBeenCalledTimes(1)
    const [cmd, opts] = mockExecSync.mock.calls[0] as [string, { cwd: string; stdio: string }]
    expect(cmd).toContain("NOTIFY_RESULT=ok")
    expect(cmd).toContain("pnpm tsx scripts/kody/notify.ts")
    expect(cmd).toContain("--agent notify-agent")
    expect(cmd).toContain("--channels slack")
    expect(cmd).toContain("--when always")
    expect(cmd).toContain("--color good")
    expect(cmd).toContain("--title")
    expect(cmd).toContain("Cycle 1")
    expect(opts.cwd).toBe("/project/root")
    expect(opts.stdio).toBe("pipe")
  })

  it("sets NOTIFY_RESULT=failure when agent fails", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "fail-agent", outcome: "failed", error: "boom" })
    const config = makeConfig({
      projectDir: "/project/root",
      agents: [{
        config: {
          name: "fail-agent",
          description: "Test",
          cron: "* * * * *",
          notify: { channels: ["slack"], color: "danger", when: "on-failure" },
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(mockExecSync).toHaveBeenCalledTimes(1)
    const [cmd] = mockExecSync.mock.calls[0] as [string]
    expect(cmd).toContain("NOTIFY_RESULT=failure")
    expect(cmd).toContain("--color danger")
  })

  it("uses notify:true shorthand defaults", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "shorthand-agent", outcome: "completed" })
    const config = makeConfig({
      projectDir: "/project/root",
      agents: [{
        config: {
          name: "shorthand-agent",
          description: "Test",
          cron: "* * * * *",
          notify: true,
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(mockExecSync).toHaveBeenCalledTimes(1)
    const [cmd] = mockExecSync.mock.calls[0] as [string]
    expect(cmd).toContain("--channels slack")
    expect(cmd).toContain("--color good")
    expect(cmd).toContain("--when always")
  })

  it("joins multiple channels with comma", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "multi-agent", outcome: "completed" })
    const config = makeConfig({
      projectDir: "/project/root",
      agents: [{
        config: {
          name: "multi-agent",
          description: "Test",
          cron: "* * * * *",
          notify: { channels: ["slack", "slack-dev"], when: "always" },
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    const [cmd] = mockExecSync.mock.calls[0] as [string]
    expect(cmd).toContain("--channels slack,slack-dev")
  })

  it("does NOT call execSync when notify is omitted", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "no-notify", outcome: "completed" })
    const config = makeConfig({
      agents: [{
        config: { name: "no-notify", description: "No notify", cron: "* * * * *" },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it("still calls execSync when notify.when is 'never' — gating is the script's job", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "never-agent", outcome: "completed" })
    const config = makeConfig({
      agents: [{
        config: {
          name: "never-agent",
          description: "Never",
          cron: "* * * * *",
          notify: { when: "never" },
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    // The engine does not gate internally — it always calls execSync and lets
    // notify.ts enforce the when condition.
    expect(mockExecSync).toHaveBeenCalled()
    const [cmd] = mockExecSync.mock.calls[0] as [string]
    expect(cmd).toContain("--when never")
  })

  it("does NOT fail the watch cycle when execSync throws", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "notify-fails", outcome: "completed" })
    mockExecSync.mockImplementation(() => { throw new Error("notify.ts not found") })

    const config = makeConfig({
      agents: [{
        config: {
          name: "notify-fails",
          description: "Test",
          cron: "* * * * *",
          notify: { when: "always" },
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    // Should not throw
    const result = await runWatch(config)

    // Watch cycle should still succeed
    expect(result.agentResults).toHaveLength(1)
    expect(result.agentResults[0].outcome).toBe("completed")
  })

  it("sets title with cycle number and outcome", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "cycle-agent", outcome: "completed" })
    const config = makeConfig({
      projectDir: "/project/root",
      agents: [{
        config: {
          name: "cycle-agent",
          description: "Test",
          cron: "* * * * *",
          notify: { when: "always" },
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    const [cmd] = mockExecSync.mock.calls[0] as [string]
    expect(cmd).toContain("watch-cycle-agent")
    expect(cmd).toContain("Cycle 1")
    expect(cmd).toContain("ok")
  })

  it("sets body to error message when agent fails", async () => {
    mockRunWatchAgent.mockResolvedValue({ agentName: "error-agent", outcome: "failed", error: "network timeout" })
    const config = makeConfig({
      projectDir: "/project/root",
      agents: [{
        config: {
          name: "error-agent",
          description: "Test",
          cron: "* * * * *",
          notify: { when: "always" },
        },
        systemPrompt: "test",
        dirPath: "/tmp",
      }],
    })

    await runWatch(config)

    const [cmd] = mockExecSync.mock.calls[0] as [string]
    expect(cmd).toContain("failure")
    expect(cmd).toContain("network timeout")
  })
})
