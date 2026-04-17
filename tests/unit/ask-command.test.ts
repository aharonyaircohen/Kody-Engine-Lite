import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies before imports
vi.mock("../../src/memory.js", () => ({
  readProjectMemory: vi.fn().mockReturnValue(""),
}))

vi.mock("../../src/context.js", () => ({
  readPromptFile: vi.fn().mockReturnValue(`You are a helpful assistant.

{{QUESTION}}

{{ISSUE_CONTEXT}}`),
}))

vi.mock("../../src/config.js", () => ({
  getProjectConfig: vi.fn().mockReturnValue({
    agent: {
      defaultRunner: "claude",
      modelMap: { cheap: "claude/haiku", mid: "claude/sonnet", strong: "claude/opus" },
    },
  }),
  resolveStageConfig: vi.fn().mockReturnValue({
    provider: "anthropic",
    model: "sonnet",
  }),
  stageNeedsProxy: vi.fn().mockReturnValue(false),
  getLitellmUrl: vi.fn().mockReturnValue("http://localhost:4000"),
}))

vi.mock("../../src/github-api.js", () => ({
  getIssue: vi.fn().mockReturnValue({
    title: "Test issue",
    body: "Issue body",
    labels: ["bug"],
    comments: [
      { body: "A comment", author: "user1", createdAt: "2026-01-01T00:00:00Z" },
    ],
    assignees: [],
    milestone: null,
  }),
  postComment: vi.fn(),
}))

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { runAsk } from "../../src/commands/ask.js"
import { postComment, getIssue } from "../../src/github-api.js"
import { readProjectMemory } from "../../src/memory.js"
import type { AgentRunner } from "../../src/types.js"

function createMockRunner(output: string = "The answer is 42"): Record<string, AgentRunner> {
  return {
    claude: {
      run: vi.fn().mockResolvedValue({ outcome: "completed", output }),
      healthCheck: vi.fn().mockResolvedValue(true),
    },
  }
}

describe("runAsk", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns answer on success (local mode)", async () => {
    const runners = createMockRunner("The answer is 42")
    const result = await runAsk({
      question: "What is the meaning of life?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-1",
      local: true,
    })

    expect(result.outcome).toBe("completed")
    expect(result.answer).toBe("The answer is 42")
  })

  it("posts comment on GitHub when not local", async () => {
    const runners = createMockRunner("Here is the answer")
    await runAsk({
      issueNumber: 42,
      question: "How does auth work?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-42",
      local: false,
    })

    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Here is the answer"),
    )
    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Kody Ask `ask-42`"),
    )
  })

  it("does not post comment in local mode", async () => {
    const runners = createMockRunner("Local answer")
    await runAsk({
      issueNumber: 42,
      question: "What framework?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-42",
      local: true,
    })

    expect(postComment).not.toHaveBeenCalled()
  })

  it("works without issue number (pure CLI mode)", async () => {
    const runners = createMockRunner("CLI answer")
    const result = await runAsk({
      question: "What is this project?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-local",
      local: true,
    })

    expect(result.outcome).toBe("completed")
    expect(result.answer).toBe("CLI answer")
    expect(getIssue).not.toHaveBeenCalled()
  })

  it("fetches issue context when issue number provided", async () => {
    const runners = createMockRunner("Answer with context")
    await runAsk({
      issueNumber: 99,
      question: "Explain this issue",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-99",
      local: true,
    })

    expect(getIssue).toHaveBeenCalledWith(99)
  })

  it("fails with empty question", async () => {
    const runners = createMockRunner()
    const result = await runAsk({
      question: "   ",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-1",
      local: true,
    })

    expect(result.outcome).toBe("failed")
    expect(result.error).toContain("No question provided")
  })

  it("fails when agent returns error", async () => {
    const runners: Record<string, AgentRunner> = {
      claude: {
        run: vi.fn().mockResolvedValue({ outcome: "failed", error: "Model error" }),
        healthCheck: vi.fn().mockResolvedValue(true),
      },
    }

    const result = await runAsk({
      question: "Will this fail?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-1",
      local: true,
    })

    expect(result.outcome).toBe("failed")
    expect(result.error).toBe("Model error")
  })

  it("posts failure comment on GitHub when agent fails (non-local)", async () => {
    const runners: Record<string, AgentRunner> = {
      claude: {
        run: vi.fn().mockResolvedValue({ outcome: "timed_out", error: "Timeout" }),
        healthCheck: vi.fn().mockResolvedValue(true),
      },
    }

    await runAsk({
      issueNumber: 42,
      question: "Will this fail?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-42",
      local: false,
    })

    expect(postComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Failed to answer"),
    )
  })

  it("includes project memory in prompt when available", async () => {
    vi.mocked(readProjectMemory).mockReturnValue("# Project Memory\n\n## architecture\nNext.js app")
    const runners = createMockRunner("Answer")

    await runAsk({
      question: "What framework?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-1",
      local: true,
    })

    const runCall = vi.mocked(runners.claude.run).mock.calls[0]
    const prompt = runCall[1] // second arg is prompt
    expect(prompt).toContain("Project Memory")
    expect(prompt).toContain("Next.js app")
  })

  it("passes correct model tier and timeout", async () => {
    const runners = createMockRunner("Answer")

    await runAsk({
      question: "What?",
      projectDir: "/tmp/test",
      runners,
      taskId: "ask-1",
      local: true,
    })

    const runCall = vi.mocked(runners.claude.run).mock.calls[0]
    expect(runCall[0]).toBe("ask")           // stage name
    expect(runCall[2]).toBe("sonnet")        // model
    expect(runCall[3]).toBe(300_000)         // timeout 5min
  })
})
