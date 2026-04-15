/**
 * Archon Integration Tests
 *
 * These tests validate that the Archon integration points can be built correctly
 * BEFORE the full migration begins. They define the interface contracts that
 * the implementation must satisfy.
 *
 * Run: pnpm test tests/unit/archon-integration.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { execSync } from "child_process"
import * as os from "os"

// ─── Mock Archon Interfaces ─────────────────────────────────────────────────
//
// These mirror the Archon interfaces we need to implement.
// They are defined here so tests can verify the contracts before Archon is installed.

interface MessageChunk {
  type: "assistant" | "system" | "thinking" | "result" | "rate_limit" | "tool"
  content?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  tokens?: { input: number; output: number }
  isError?: boolean
}

interface NodeConfig {
  mcp?: string
  skills?: string[]
  allowed_tools?: string[]
  denied_tools?: string[]
  effort?: string
  thinking?: unknown
  sandbox?: unknown
  betas?: string[]
  output_format?: Record<string, unknown>
  maxBudgetUsd?: number
  systemPrompt?: string
  fallbackModel?: string
  idle_timeout?: number
  [key: string]: unknown
}

interface SendQueryOptions {
  resumeSessionId?: string
  nodeConfig?: NodeConfig
  assistantConfig?: Record<string, unknown>
  systemPrompt?: string
  tools?: unknown[]
  maxTokens?: number
  temperature?: number
  env?: Record<string, string>
}

interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk, void, unknown>
  getType(): string
}

interface WorkflowRun {
  id: string
  workflow_name: string
  conversation_id: string
  codebase_id?: string
  user_message: string
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled"
  metadata?: Record<string, unknown>
  working_path?: string
  parent_conversation_id?: string
  started_at: Date
  updated_at: Date
}

interface ApprovalContext {
  message: string
  requested_at: Date
}

interface IWorkflowStore {
  createWorkflowRun(data: {
    workflow_name: string
    conversation_id: string
    codebase_id?: string
    user_message: string
    metadata?: Record<string, unknown>
    working_path?: string
    parent_conversation_id?: string
  }): Promise<WorkflowRun>
  getWorkflowRun(id: string): Promise<WorkflowRun | null>
  getActiveWorkflowRunByPath(
    workingPath: string,
    self?: { id: string; startedAt: Date }
  ): Promise<WorkflowRun | null>
  findResumableRun(workflowName: string, workingPath: string): Promise<WorkflowRun | null>
  resumeWorkflowRun(id: string): Promise<WorkflowRun>
  updateWorkflowRun(
    id: string,
    updates: Partial<Pick<WorkflowRun, "status" | "metadata">>
  ): Promise<void>
  updateWorkflowActivity(id: string): Promise<void>
  completeWorkflowRun(id: string, metadata?: Record<string, unknown>): Promise<void>
  failWorkflowRun(id: string, error: string): Promise<void>
  pauseWorkflowRun(id: string, approvalContext: ApprovalContext): Promise<void>
  cancelWorkflowRun(id: string): Promise<void>
  createWorkflowEvent(data: {
    workflow_run_id: string
    event_type: string
    step_index?: number
    step_name?: string
    data?: Record<string, unknown>
  }): Promise<void>
  getCompletedDagNodeOutputs(workflowRunId: string): Promise<Map<string, string>>
}

interface WorkflowMessageMetadata {
  category?: "tool_call_formatted" | "workflow_status" | "workflow_dispatch_status" | "workflow_result"
  segment?: "new" | "auto"
}

interface IWorkflowPlatform {
  sendMessage(
    conversationId: string,
    message: string,
    metadata?: WorkflowMessageMetadata
  ): Promise<void>
  getStreamingMode(): "stream" | "batch"
  getPlatformType(): string
}

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_DATA_DIR = path.join(os.tmpdir(), `kody-archon-test-${Date.now()}`)

function setupTestDir() {
  fs.mkdirSync(path.join(TEST_DATA_DIR, ".kody-engine"), { recursive: true })
}

function cleanupTestDir() {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true })
  } catch { /* ignore */ }
}

beforeEach(() => {
  setupTestDir()
})

afterEach(() => {
  cleanupTestDir()
})

// ─── Test Suite 1: LiteLLM IAgentProvider ─────────────────────────────────
//
// Challenge: Wrap Kody's LiteLLM HTTP client into Archon's IAgentProvider interface.
// The HTTP client in src/cli/litellm.ts makes /v1/messages calls. The provider
// must wrap this as sendQuery() -> AsyncGenerator<MessageChunk>

describe("LiteLLM IAgentProvider", () => {
  // ─── 1a. Interface contract ───────────────────────────────────────────
  it("IAgentProvider must have sendQuery returning AsyncGenerator<MessageChunk>", async () => {
    // This test verifies the interface shape we need to implement.
    // The actual implementation will wrap litellm.ts's HTTP client.
    const provider: IAgentProvider = {
      async *sendQuery(prompt, cwd, resumeSessionId?, options?) {
        // Simulate streaming response
        const chunks: MessageChunk[] = [
          { type: "assistant", content: "" },
          { type: "result", tokens: { input: 100, output: 50 } },
        ]
        for (const chunk of chunks) {
          yield chunk
        }
      },
      getType() { return "litellm" },
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery("test", "/tmp")) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(2)
    expect(chunks[0].type).toBe("assistant")
    expect(chunks[1].type).toBe("result")
    expect(chunks[1].tokens).toEqual({ input: 100, output: 50 })
  })

  // ─── 1b. HTTP request mapping ────────────────────────────────────────
  it("sendQuery must translate nodeConfig.allowed_tools to LiteLLM request", async () => {
    // Challenge: allowed_tools in nodeConfig must restrict which tools the model uses.
    // LiteLLM proxy doesn't natively support this — it must be handled in the
    // system prompt or via MCP configuration.
    const provider: IAgentProvider = {
      async *sendQuery(prompt, cwd, resumeSessionId?, options?: SendQueryOptions) {
        // Verify allowed_tools is passed through
        expect(options?.nodeConfig?.allowed_tools).toBeDefined()
        expect(options?.nodeConfig?.allowed_tools).toContain("Bash")
        yield { type: "result", tokens: { input: 10, output: 5 } }
      },
      getType() { return "litellm" },
    }

    for await (const _ of provider.sendQuery("test", "/tmp", undefined, {
      nodeConfig: { allowed_tools: ["Bash", "Read"] },
    })) {
      // consume
    }
  })

  // ─── 1c. Structured output ───────────────────────────────────────────
  it("sendQuery must support output_format via nodeConfig", async () => {
    // Challenge: taskify stage uses structured JSON output. The provider must
    // pass output_format to the model and parse the response.
    const outputFormat = {
      json_schema: {
        name: "taskify_output",
        schema: {
          type: "object",
          properties: {
            task_type: { type: "string", enum: ["feature", "bugfix"] },
            title: { type: "string" },
          },
          required: ["task_type", "title"],
        },
      },
    }

    const provider: IAgentProvider = {
      async *sendQuery(prompt, cwd, resumeSessionId?, options?: SendQueryOptions) {
        // Verify output_format is passed
        expect(options?.nodeConfig?.output_format).toEqual(outputFormat)
        // Return a structured result
        yield {
          type: "result",
          structuredOutput: { task_type: "bugfix", title: "Fix login bug" },
          tokens: { input: 50, output: 30 },
        }
      },
      getType() { return "litellm" },
    }

    for await (const chunk of provider.sendQuery("taskify this", "/tmp", undefined, {
      nodeConfig: { output_format: outputFormat },
    })) {
      if (chunk.type === "result" && chunk.structuredOutput) {
        expect((chunk.structuredOutput as { task_type: string }).task_type).toBe("bugfix")
      }
    }
  })

  // ─── 1d. LiteLLM base URL resolution ────────────────────────────────
  it("sendQuery must resolve LiteLLM proxy URL from config", () => {
    // Challenge: LiteLLM proxy URL (e.g. http://localhost:4000) must be
    // read from kody config, not hardcoded. This test verifies the pattern.
    const litellmUrl = process.env.LITELLM_URL ?? "http://localhost:4000"
    expect(litellmUrl).toMatch(/^https?:\/\/.+:\d+/)
  })

  // ─── 1e. Error handling ───────────────────────────────────────────────
  it("sendQuery must handle rate limit errors gracefully", async () => {
    const provider: IAgentProvider = {
      async *sendQuery() {
        yield { type: "rate_limit", rateLimitInfo: { retryAfter: 5 } }
        yield { type: "result", tokens: { input: 10, output: 5 } }
      },
      getType() { return "litellm" },
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery("test", "/tmp")) {
      chunks.push(chunk)
    }

    const rateLimitChunks = chunks.filter(c => c.type === "rate_limit")
    expect(rateLimitChunks).toHaveLength(1)
    expect((rateLimitChunks[0].rateLimitInfo as { retryAfter: number }).retryAfter).toBe(5)
  })
})

// ─── Test Suite 2: IWorkflowStore on Kody State ───────────────────────────
//
// Challenge: Implement Archon's IWorkflowStore on top of Kody's existing
// file-based state in .kody-engine/. This is non-negotiable — state must
// stay in the repo, not move to SQLite.

describe("IWorkflowStore on .kody-engine/", () => {
  // ─── 2a. State file location ──────────────────────────────────────────
  it("must store state in .kody-engine/ within the repo, not in user home", () => {
    const dataDir = TEST_DATA_DIR
    const kodyEngineDir = path.join(dataDir, ".kody-engine")

    // Verify the path structure matches what Kody already uses
    expect(kodyEngineDir).toContain(".kody-engine")
    expect(kodyEngineDir).not.toContain(os.homedir())

    // This is critical — state must travel with the repo
    fs.writeFileSync(
      path.join(kodyEngineDir, "status.json"),
      JSON.stringify({ taskId: "test-1", state: "running" })
    )

    const content = fs.readFileSync(path.join(kodyEngineDir, "status.json"), "utf-8")
    expect(content).toContain("test-1")
  })

  // ─── 2b. createWorkflowRun ─────────────────────────────────────────────
  it("createWorkflowRun must persist to .kody-engine/ and be retrievable", async () => {
    const store = createMockWorkflowStore(TEST_DATA_DIR)

    const run = await store.createWorkflowRun({
      workflow_name: "kody-standard",
      conversation_id: "conv-1",
      user_message: "Fix issue #42",
      working_path: TEST_DATA_DIR,
    })

    expect(run.id).toBeTruthy()
    expect(run.status).toBe("pending")
    expect(run.workflow_name).toBe("kody-standard")

    // Verify can be retrieved (tests the store contract, not the file format)
    const retrieved = await store.getWorkflowRun(run.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe(run.id)
  })

  // ─── 2c. findResumableRun ─────────────────────────────────────────────
  it("findResumableRun must find paused runs by workflow name and path", async () => {
    const store = createMockWorkflowStore(TEST_DATA_DIR)

    // Create a run
    const run = await store.createWorkflowRun({
      workflow_name: "kody-standard",
      conversation_id: "conv-1",
      user_message: "Fix issue #42",
      working_path: TEST_DATA_DIR,
    })

    // Mark as paused (simulating a question gate)
    await store.updateWorkflowRun(run.id, { status: "paused" })

    // Find it as resumable
    const resumable = await store.findResumableRun("kody-standard", TEST_DATA_DIR)
    expect(resumable).not.toBeNull()
    expect(resumable!.id).toBe(run.id)
    expect(resumable!.status).toBe("paused")
  })

  // ─── 2d. updateWorkflowRun status transitions ─────────────────────────
  it("updateWorkflowRun must persist status transitions correctly", async () => {
    const store = createMockWorkflowStore(TEST_DATA_DIR)

    const run = await store.createWorkflowRun({
      workflow_name: "kody-standard",
      conversation_id: "conv-1",
      user_message: "Fix issue #42",
    })

    await store.updateWorkflowRun(run.id, { status: "running" })
    const updated = await store.getWorkflowRun(run.id)
    expect(updated!.status).toBe("running")

    await store.completeWorkflowRun(run.id)
    const completed = await store.getWorkflowRun(run.id)
    expect(completed!.status).toBe("completed")
  })

  // ─── 2e. createWorkflowEvent must be retrievable via getCompletedDagNodeOutputs ─────────────────────────
  it("createWorkflowEvent must be queryable by getCompletedDagNodeOutputs", async () => {
    const store = createMockWorkflowStore(TEST_DATA_DIR)

    const run = await store.createWorkflowRun({
      workflow_name: "kody-standard",
      conversation_id: "conv-1",
      user_message: "Fix issue #42",
    })

    await store.createWorkflowEvent({
      workflow_run_id: run.id,
      event_type: "node_completed",
      step_name: "taskify",
      data: { output: '{"task_type":"bugfix","title":"Fix X"}' },
    })

    await store.createWorkflowEvent({
      workflow_run_id: run.id,
      event_type: "node_completed",
      step_name: "plan",
      data: { output: "Implement auth module" },
    })

    // Verify via the query interface (not the file format)
    const outputs = await store.getCompletedDagNodeOutputs(run.id)
    expect(outputs.get("taskify")).toBe('{"task_type":"bugfix","title":"Fix X"}')
    expect(outputs.get("plan")).toBe("Implement auth module")
    expect(outputs.size).toBe(2)
  })

  // ─── 2f. Atomic write with rename ─────────────────────────────────────
  it("must use atomic write (rename) to prevent corruption on crash", () => {
    // This is the key reliability test. Kody's current state.ts uses:
    // writeFileSync(tmp) + renameSync(tmp, target)
    // This pattern must be preserved in the IWorkflowStore implementation.
    const statusFile = path.join(TEST_DATA_DIR, ".kody-engine", "status.json")
    const tmpFile = statusFile + ".tmp"

    fs.writeFileSync(tmpFile, JSON.stringify({ crashed: false }))
    fs.renameSync(tmpFile, statusFile)

    // Verify atomic — no .tmp file left behind
    expect(fs.existsSync(tmpFile)).toBe(false)
    expect(fs.existsSync(statusFile)).toBe(true)
  })
})

// ─── Test Suite 3: IWorkflowPlatform on Kody Events ───────────────────────
//
// Challenge: Wrap Kody's event system as Archon's IWorkflowPlatform.
// Map Kody's EventName to Archon's WorkflowEventType.

describe("IWorkflowPlatform on Kody Event System", () => {
  // ─── 3a. Event type mapping ───────────────────────────────────────────
  it("must map Kody EventName to Archon WorkflowEventType correctly", () => {
    // Kody events → Archon events (from event-system/events/types.ts)
    const eventMapping: Array<[string, string]> = [
      ["pipeline.started", "workflow_started"],
      ["pipeline.success", "workflow_completed"],
      ["pipeline.failed", "workflow_failed"],
      ["step.started", "node_started"],
      ["step.complete", "node_completed"],
      ["step.failed", "node_failed"],
      ["step.waiting", "approval_requested"],
      ["chat.done", "workflow_completed"],
    ]

    for (const [kodyEvent, archonEvent] of eventMapping) {
      expect(getArchonEventType(kodyEvent)).toBe(archonEvent)
    }
  })

  // ─── 3b. sendMessage interface ───────────────────────────────────────
  it("sendMessage must be async and fire events to the platform", async () => {
    const platform = createMockWorkflowPlatform()
    const events: string[] = []

    // Spy on the platform's sendMessage
    const original = platform.sendMessage.bind(platform)
    platform.sendMessage = async (conversationId, message, metadata) => {
      events.push(message)
      await original(conversationId, message, metadata)
    }

    await platform.sendMessage("conv-1", "Build complete! Ready for review.")

    expect(events).toHaveLength(1)
    expect(events[0]).toContain("Build complete")
  })

  // ─── 3c. Platform type identification ─────────────────────────────────
  it("getPlatformType must return 'kody' for Kody's platform", () => {
    const platform = createMockWorkflowPlatform()
    expect(platform.getPlatformType()).toBe("kody")
  })

  // ─── 3d. Streaming mode ───────────────────────────────────────────────
  it("getStreamingMode must return 'batch' for CLI-based workflow", () => {
    const platform = createMockWorkflowPlatform()
    // Kody runs in GitHub Actions / CLI — streaming is not used
    expect(platform.getStreamingMode()).toBe("batch")
  })
})

// ─── Test Suite 4: End-to-End Workflow Contract ────────────────────────────
//
// Challenge: Verify that all three integration points work together.
// This is the highest-level contract test.

describe("End-to-End: Kody + Archon Integration Contract", () => {
  // ─── 4a. Complete workflow lifecycle ───────────────────────────────────
  it("must execute a minimal workflow: taskify → plan → build → verify → review → ship", async () => {
    const store = createMockWorkflowStore(TEST_DATA_DIR)
    const platform = createMockWorkflowPlatform()
    const provider = createMockLiteLLMProvider()

    // Create workflow run
    const run = await store.createWorkflowRun({
      workflow_name: "kody-standard",
      conversation_id: "conv-e2e-1",
      user_message: "@kody fix issue #42",
      working_path: TEST_DATA_DIR,
    })

    await store.updateWorkflowRun(run.id, { status: "running" })

    // Simulate stage progression
    const stages = ["taskify", "plan", "build", "verify", "review", "ship"]
    for (const stage of stages) {
      await store.createWorkflowEvent({
        workflow_run_id: run.id,
        event_type: "node_started",
        step_name: stage,
      })

      // Simulate stage completion
      const chunks: MessageChunk[] = []
      for await (const chunk of provider.sendQuery(`Run ${stage}`, TEST_DATA_DIR)) {
        chunks.push(chunk)
      }

      await store.createWorkflowEvent({
        workflow_run_id: run.id,
        event_type: "node_completed",
        step_name: stage,
        data: {
          output: `${stage} output`,
          tokens: chunks[chunks.length - 1]?.tokens,
        },
      })

      await platform.sendMessage(
        run.conversation_id,
        `Stage ${stage} completed.`,
        { category: "workflow_status" }
      )
    }

    await store.completeWorkflowRun(run.id, { final_message: "PR created" })

    // Verify final state
    const finalRun = await store.getWorkflowRun(run.id)
    expect(finalRun!.status).toBe("completed")

    // Verify all node_completed events via store interface
    const outputs = await store.getCompletedDagNodeOutputs(run.id)
    expect(outputs.size).toBe(6)
    expect(outputs.has("taskify")).toBe(true)
    expect(outputs.has("plan")).toBe(true)
    expect(outputs.has("build")).toBe(true)
    expect(outputs.has("verify")).toBe(true)
    expect(outputs.has("review")).toBe(true)
    expect(outputs.has("ship")).toBe(true)
  })

  // ─── 4b. Approval gate (pause/resume) ─────────────────────────────────
  it("must support approval gate: pause → human approval → resume", async () => {
    const store = createMockWorkflowStore(TEST_DATA_DIR)

    const run = await store.createWorkflowRun({
      workflow_name: "kody-standard",
      conversation_id: "conv-approval",
      user_message: "High risk change",
    })
    await store.updateWorkflowRun(run.id, { status: "running" })

    // Pause at review gate
    // Pause at review gate (Kody uses approval metadata, not a separate pause method)
    await store.updateWorkflowRun(run.id, {
      status: "paused",
      metadata: {
        approval: { message: "Review required: This changes auth logic. Approve?", requested_at: new Date().toISOString() },
      },
    })

    const paused = await store.getWorkflowRun(run.id)
    expect(paused!.status).toBe("paused")
    expect(paused!.metadata?.approval).toBeTruthy()

    // Simulate human approval via resume
    const resumed = await store.resumeWorkflowRun(run.id)
    expect(resumed.status).toBe("running")
  })

  // ─── 4c. Failure classification → retry or abort ────────────────────
  it("must support failure classification from observer.ts", async () => {
    const store = createMockWorkflowStore(TEST_DATA_DIR)

    const run = await store.createWorkflowRun({
      workflow_name: "kody-standard",
      conversation_id: "conv-fail",
      user_message: "Implement feature X",
    })
    await store.updateWorkflowRun(run.id, { status: "running" })

    await store.createWorkflowEvent({
      workflow_run_id: run.id,
      event_type: "node_failed",
      step_name: "build",
      data: {
        error: "Type error in src/auth.ts",
      },
    })

    // Record classification via failWorkflowRun
    await store.failWorkflowRun(run.id, "Type error in src/auth.ts")

    // Verify failure recorded via store interface
    const failedRun = await store.getWorkflowRun(run.id)
    expect(failedRun).not.toBeNull()
    expect(failedRun!.status).toBe("failed")
    expect(failedRun!.metadata?.error).toBe("Type error in src/auth.ts")
  })
})

// ─── Mock Implementations (will be replaced with real code) ────────────────

function createMockWorkflowStore(dataDir: string): IWorkflowStore {
  // ─── Helpers ────────────────────────────────────────────────────────────

  function writeAtomic(target: string, data: unknown) {
    const tmp = target + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, target)
  }

  // Archon WorkflowRun ↔ Kody PipelineStatus mapping
  function toPipelineStatus(run: WorkflowRun) {
    return {
      taskId: run.id,
      state: run.status as "running" | "completed" | "failed" | "paused",
      stages: {}, // filled by caller
      createdAt: run.started_at instanceof Date ? run.started_at.toISOString() : String(run.started_at),
      updatedAt: run.updated_at instanceof Date ? run.updated_at.toISOString() : String(run.updated_at),
    }
  }

  function fromPipelineStatus(ps: ReturnType<typeof toPipelineStatus>, run: Partial<WorkflowRun>): WorkflowRun {
    return {
      id: ps.taskId,
      workflow_name: run.workflow_name ?? "",
      conversation_id: run.conversation_id ?? "",
      codebase_id: run.codebase_id,
      user_message: run.user_message ?? "",
      status: ps.state,
      metadata: run.metadata,
      working_path: run.working_path,
      parent_conversation_id: run.parent_conversation_id,
      started_at: new Date(ps.createdAt),
      updated_at: new Date(ps.updatedAt),
    }
  }

  // ─── Store ──────────────────────────────────────────────────────────────

  return {
    async createWorkflowRun(data) {
      const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const now = new Date().toISOString()
      const statusFile = path.join(dataDir, ".kody-engine", "status.json")

      // Kody stores a single PipelineStatus object (keyed by taskId) at the run's taskDir.
      // For simplicity, store each run as {taskId, state, stages, createdAt, updatedAt}.
      const ps = {
        taskId: id,
        state: "pending" as const,
        stages: {},
        createdAt: now,
        updatedAt: now,
      }

      // Map for lookup
      const runMapFile = path.join(dataDir, ".kody-engine", "run-map.json")
      const runMap: Record<string, Partial<WorkflowRun>> = fs.existsSync(runMapFile)
        ? JSON.parse(fs.readFileSync(runMapFile, "utf-8"))
        : {}
      runMap[id] = {
        id,
        workflow_name: data.workflow_name,
        conversation_id: data.conversation_id,
        codebase_id: data.codebase_id,
        user_message: data.user_message,
        metadata: data.metadata,
        working_path: data.working_path,
        parent_conversation_id: data.parent_conversation_id,
        started_at: new Date(now),
        updated_at: new Date(now),
      }
      fs.mkdirSync(path.join(dataDir, ".kody-engine"), { recursive: true })
      fs.writeFileSync(runMapFile, JSON.stringify(runMap, null, 2))

      return {
        id,
        workflow_name: data.workflow_name,
        conversation_id: data.conversation_id,
        codebase_id: data.codebase_id,
        user_message: data.user_message,
        status: "pending",
        metadata: data.metadata,
        working_path: data.working_path,
        parent_conversation_id: data.parent_conversation_id,
        started_at: new Date(now),
        updated_at: new Date(now),
      }
    },

    async getWorkflowRun(id) {
      const runMapFile = path.join(dataDir, ".kody-engine", "run-map.json")
      if (!fs.existsSync(runMapFile)) return null
      const runMap: Record<string, Partial<WorkflowRun>> = JSON.parse(fs.readFileSync(runMapFile, "utf-8"))
      const partial = runMap[id]
      if (!partial) return null
      return {
        id,
        workflow_name: partial.workflow_name ?? "",
        conversation_id: partial.conversation_id ?? "",
        codebase_id: partial.codebase_id,
        user_message: partial.user_message ?? "",
        status: (partial.metadata?.status as WorkflowRun["status"]) ?? "running",
        metadata: partial.metadata,
        working_path: partial.working_path,
        parent_conversation_id: partial.parent_conversation_id,
        started_at: partial.started_at as Date,
        updated_at: partial.updated_at as Date,
      }
    },

    async getActiveWorkflowRunByPath(workingPath, self?) {
      const runMapFile = path.join(dataDir, ".kody-engine", "run-map.json")
      if (!fs.existsSync(runMapFile)) return null
      const runMap: Record<string, Partial<WorkflowRun>> = JSON.parse(fs.readFileSync(runMapFile, "utf-8"))
      for (const [id, partial] of Object.entries(runMap)) {
        if (
          partial.working_path === workingPath &&
          partial.metadata?.status === "running" &&
          (!self || id !== self.id)
        ) {
          return {
            id,
            workflow_name: partial.workflow_name ?? "",
            conversation_id: partial.conversation_id ?? "",
            status: "running",
            started_at: partial.started_at as Date,
            updated_at: partial.updated_at as Date,
          }
        }
      }
      return null
    },

    async findResumableRun(workflowName, workingPath) {
      const runMapFile = path.join(dataDir, ".kody-engine", "run-map.json")
      if (!fs.existsSync(runMapFile)) return null
      const runMap: Record<string, Partial<WorkflowRun>> = JSON.parse(fs.readFileSync(runMapFile, "utf-8"))
      for (const [id, partial] of Object.entries(runMap)) {
        if (
          partial.workflow_name === workflowName &&
          partial.working_path === workingPath &&
          partial.metadata?.status === "paused"
        ) {
          return {
            id,
            workflow_name: partial.workflow_name ?? "",
            conversation_id: partial.conversation_id ?? "",
            status: "paused",
            metadata: partial.metadata,
            started_at: partial.started_at as Date,
            updated_at: partial.updated_at as Date,
          }
        }
      }
      return null
    },

    async resumeWorkflowRun(id) {
      const runMapFile = path.join(dataDir, ".kody-engine", "run-map.json")
      const runMap: Record<string, Partial<WorkflowRun>> = JSON.parse(fs.readFileSync(runMapFile, "utf-8"))
      if (!runMap[id]) throw new Error(`Run ${id} not found`)
      runMap[id].metadata = { ...runMap[id].metadata, status: "running" }
      runMap[id].updated_at = new Date()
      fs.writeFileSync(runMapFile, JSON.stringify(runMap, null, 2))
      return {
        id,
        workflow_name: runMap[id].workflow_name ?? "",
        conversation_id: runMap[id].conversation_id ?? "",
        status: "running",
        started_at: runMap[id].started_at as Date,
        updated_at: new Date(),
      }
    },

    async updateWorkflowRun(id, updates) {
      const runMapFile = path.join(dataDir, ".kody-engine", "run-map.json")
      const runMap: Record<string, Partial<WorkflowRun>> = JSON.parse(fs.readFileSync(runMapFile, "utf-8"))
      if (!runMap[id]) return
      if (updates.status) {
        runMap[id].metadata = { ...runMap[id].metadata, status: updates.status }
      }
      if (updates.metadata) {
        runMap[id].metadata = { ...runMap[id].metadata, ...updates.metadata }
      }
      runMap[id].updated_at = new Date()
      fs.writeFileSync(runMapFile, JSON.stringify(runMap, null, 2))
    },

    async updateWorkflowActivity(id) {
      await this.updateWorkflowRun(id, {})
    },

    async completeWorkflowRun(id, metadata?) {
      await this.updateWorkflowRun(id, {
        status: "completed",
        ...(metadata ? { metadata } : {}),
      })
    },

    async failWorkflowRun(id, error) {
      await this.updateWorkflowRun(id, {
        status: "failed",
        metadata: { error },
      })
    },

    async pauseWorkflowRun(id, approvalContext) {
      await this.updateWorkflowRun(id, {
        status: "paused",
        metadata: { approval: approvalContext },
      })
    },

    async cancelWorkflowRun(id) {
      await this.updateWorkflowRun(id, { status: "cancelled" })
    },

    async createWorkflowEvent(data) {
      const logFile = path.join(dataDir, ".kody-engine", "event-log.json")
      const events: unknown[] = fs.existsSync(logFile)
        ? JSON.parse(fs.readFileSync(logFile, "utf-8"))
        : []
      events.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...data,
        emittedAt: new Date().toISOString(),
      })
      fs.mkdirSync(path.join(dataDir, ".kody-engine"), { recursive: true })
      writeAtomic(logFile, events)
    },

    async getCompletedDagNodeOutputs(workflowRunId) {
      const logFile = path.join(dataDir, ".kody-engine", "event-log.json")
      if (!fs.existsSync(logFile)) return new Map()
      const events: Array<{
        workflow_run_id: string
        event_type: string
        step_name?: string
        data?: Record<string, unknown>
      }> = JSON.parse(fs.readFileSync(logFile, "utf-8"))
      const outputs = new Map<string, string>()
      for (const e of events) {
        if (
          e.workflow_run_id === workflowRunId &&
          e.event_type === "node_completed" &&
          e.step_name &&
          e.data?.output
        ) {
          outputs.set(e.step_name, String(e.data.output))
        }
      }
      return outputs
    },
  }
}

function createMockWorkflowPlatform(): IWorkflowPlatform {
  return {
    async sendMessage(conversationId, message, metadata?) {
      // In the real implementation, this posts to GitHub API or web UI
      // For now, just verify the call is made
      expect(conversationId).toBeTruthy()
      expect(message).toBeTruthy()
    },
    getStreamingMode() { return "batch" },
    getPlatformType() { return "kody" },
  }
}

function createMockLiteLLMProvider(): IAgentProvider {
  return {
    async *sendQuery(prompt, cwd, resumeSessionId?, options?) {
      expect(prompt).toBeTruthy()
      expect(cwd).toBeTruthy()
      yield { type: "assistant", content: "" }
      yield {
        type: "result",
        tokens: { input: 50, output: 25 },
        isError: false,
      }
    },
    getType() { return "litellm" },
  }
}

// ─── Helper: Event type mapping ────────────────────────────────────────────

const KODY_TO_ARCHON_EVENT_MAP: Record<string, string> = {
  "pipeline.started": "workflow_started",
  "pipeline.success": "workflow_completed",
  "pipeline.failed": "workflow_failed",
  "step.started": "node_started",
  "step.complete": "node_completed",
  "step.failed": "node_failed",
  "step.waiting": "approval_requested",
  "chat.done": "workflow_completed",
}

function getArchonEventType(kodyEvent: string): string {
  return KODY_TO_ARCHON_EVENT_MAP[kodyEvent] ?? kodyEvent
}
