/**
 * Integration tests for the chat command flow.
 *
 * Tests the full `kody chat` pipeline:
 * 1. Session file is read
 * 2. Claude Code is invoked (mocked)
 * 3. Session file is updated with assistant response
 * 4. Chat events are emitted and logged
 * 5. CLI arguments are parsed correctly
 *
 * Uses vi.mock to replace child_process.spawn without stubbing the
 * global `process` object (which would break entry.ts event listeners).
 *
 * CRITICAL: _setDataDir must be called BEFORE importing chat.ts, because
 * chat.ts statically imports the event system (event-log.ts), which
 * captures process.cwd() at module evaluation time. Dynamic import()
 * ensures the store is evaluated after _setDataDir is set.
 *
 * CRITICAL: process.exit is replaced via vi.mock (not vi.spyOn) so that
 * execution halts at the exit call rather than continuing to the next line.
 * vi.spyOn(process, "exit").mockImplementation(()=>{}) does NOT halt execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ─── Mutable state shared between vi.mock and test code ────────────────────────

let spawnCalls: Array<{ cmd: string; args: string[]; cwd: string }> = []
let mockResponseText = "I'm happy to help!"

// Tracks process.exit calls for error-path tests.
let exitCalls: Array<number> = []
let processExitThrown = false

// ─── Mock child_process module ──────────────────────────────────────────────────

vi.mock("child_process", () => {
  const { EventEmitter } = require("events")
  return {
    spawn: (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; stdio?: unknown[] }) => {
      spawnCalls.push({ cmd, args, cwd: opts.cwd ?? "" })

      const emitter = new EventEmitter()
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()

      const mockChild = {
        pid: 12345,
        stdout,
        stderr,
        stdin: {
          write: (_data: unknown, cb?: () => void) => { cb?.() },
          end: () => {},
        },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler)
          return mockChild
        },
        off: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.off(event, handler)
          return mockChild
        },
        kill: () => {},
        then: (_resolve: unknown, _reject: unknown) => Promise.resolve(),
      } as unknown as ReturnType<typeof import("child_process").spawn>

      setImmediate(() => {
        const response = mockResponseText
        const chunks = claudeStreamJson(response).split("\n")
        for (const chunk of chunks) {
          if (chunk.trim()) {
            stdout.emit("data", Buffer.from(chunk + "\n"))
          }
        }
        setImmediate(() => {
          stdout.emit("close")
          emitter.emit("close", 0)
        })
      })

      return mockChild
    },
  }
})

function claudeStreamJson(responseText: string): string {
  const lines = []
  lines.push(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: responseText }],
    },
  }))
  lines.push(JSON.stringify({ type: "result", result: responseText }))
  return lines.join("\n") + "\n"
}

// ─── Stub process.exit globally ────────────────────────────────────────────────
//
// vi.spyOn(process, "exit").mockImplementation(() => {}) replaces the method
// but execution continues past process.exit(1) because the no-op doesn't halt.
// vi.stubGlobal replaces the actual global, so chat.ts sees it at call time.
// The stub throws a sentinel Error so execution halts and the test can catch it.

let _mockExitCode: number | undefined

function makeExitStub() {
  return function processExitStub(code: number = 0): never {
    exitCalls.push(code)
    _mockExitCode = code
    processExitThrown = true
    throw new Error(`process.exit(${code})`)
  }
}

// Replace the global process.exit BEFORE any module loads it.
const originalExit = process.exit.bind(process)
// @ts-expect-error — replacing the method on the global for test isolation
process.exit = makeExitStub()

afterEach(() => {
  // Restore original process.exit so other tests are unaffected
  // @ts-expect-error
  process.exit = originalExit
  process.chdir(prevCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ─── Mock GitHub API ───────────────────────────────────────────────────────────

vi.mock("../../src/github-api.js", () => ({
  setLabel: vi.fn().mockResolvedValue(undefined),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  postComment: vi.fn().mockResolvedValue(undefined),
}))

// ─── Test helpers ───────────────────────────────────────────────────────────────

let tmpDir: string
let prevCwd: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-int-test-"))
  prevCwd = process.cwd()
  process.chdir(tmpDir)
  fs.mkdirSync(".kody/sessions", { recursive: true })
  fs.mkdirSync(".kody/events", { recursive: true })
  fs.mkdirSync(".kody-engine", { recursive: true })
  spawnCalls = []
  exitCalls = []
  _mockExitCode = undefined
  processExitThrown = false

  // Re-install the process.exit stub for this test.
  // afterEach of the previous test restored the original; put the stub back.
  // @ts-expect-error
  process.exit = makeExitStub()

  vi.resetModules()

  // Set _setDataDir BEFORE importing chat.ts so event-log uses tmpDir.
  const { _setDataDir } = await import("../../src/event-system/store/event-log.js")
  _setDataDir(tmpDir)
})

// chatCommand is loaded fresh in each test so it picks up the current _setDataDir.
async function loadChatCommand(): Promise<(...args: unknown[]) => Promise<void>> {
  const mod = await import("../../src/bin/commands/chat.js")
  return mod.chatCommand as (...args: unknown[]) => Promise<void>
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("chat command integration", () => {
  describe("session file format", () => {
    it("reads existing session and appends assistant response", async () => {
      const sessionId = "sess-integration-1"
      const sessionFile = path.join(tmpDir, ".kody/sessions", `${sessionId}.jsonl`)
      const timestamp = new Date().toISOString()

      fs.writeFileSync(sessionFile, JSON.stringify({
        role: "user",
        content: "Refactor the database layer",
        timestamp,
        toolCalls: [],
      }) + "\n")

      mockResponseText = "I'll start by examining the database schema."
      const chatCommand = await loadChatCommand()
      await chatCommand(["--session", sessionId, "--cwd", tmpDir])

      const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n")
      expect(lines).toHaveLength(2)
      const assistantLine = JSON.parse(lines[1])
      expect(assistantLine.role).toBe("assistant")
      expect(assistantLine.content).toBe("I'll start by examining the database schema.")
      expect(assistantLine.toolCalls).toBeDefined()
    })

    it("exits with code 1 when session file does not exist and no --message provided", async () => {
      const sessionId = "sess-nonexistent-1"
      const chatCommand = await loadChatCommand()
      try {
        await chatCommand(["--session", sessionId, "--cwd", tmpDir])
      } catch (err: unknown) {
        // Expected: process.exit mock throws to halt execution
      }
      expect(exitCalls).toContain(1)
    })

    it("exits with code 1 when --session is not provided", async () => {
      const chatCommand = await loadChatCommand()
      try {
        await chatCommand([])
      } catch (err: unknown) {
        // Expected: process.exit mock throws to halt execution
      }
      expect(exitCalls).toContain(1)
    })
  })

  describe("Claude Code invocation", () => {
    it("spawns the claude binary with correct arguments", async () => {
      spawnCalls = []
      const sessionId = "sess-claude-args"
      const sessionFile = path.join(tmpDir, ".kody/sessions", `${sessionId}.jsonl`)
      fs.writeFileSync(sessionFile, JSON.stringify({
        role: "user",
        content: "hello",
        timestamp: new Date().toISOString(),
        toolCalls: [],
      }) + "\n")

      mockResponseText = "Hello!"
      const chatCommand = await loadChatCommand()
      await chatCommand(["--session", sessionId, "--model", "claude-opus-4-6", "--cwd", tmpDir])

      expect(spawnCalls.some((c) => c.cmd === "claude")).toBe(true)
      const claudeCall = spawnCalls.find((c) => c.cmd === "claude")!
      expect(claudeCall.args).toContain("--model")
      const modelIdx = claudeCall.args.indexOf("--model")
      expect(claudeCall.args[modelIdx + 1]).toBe("claude-opus-4-6")
      expect(claudeCall.args).toContain("--dangerously-skip-permissions")
      expect(claudeCall.args).toContain("--output-format")
      expect(claudeCall.args).toContain("stream-json")
    })

    it("runs in the --cwd directory", async () => {
      spawnCalls = []
      const sessionId = "sess-cwd-test"
      const sessionFile = path.join(tmpDir, ".kody/sessions", `${sessionId}.jsonl`)
      fs.writeFileSync(sessionFile, JSON.stringify({
        role: "user",
        content: "hello",
        timestamp: new Date().toISOString(),
        toolCalls: [],
      }) + "\n")

      mockResponseText = "response"
      const chatCommand = await loadChatCommand()
      await chatCommand(["--session", sessionId, "--cwd", tmpDir])

      const claudeCall = spawnCalls.find((c) => c.cmd === "claude")!
      expect(claudeCall.cwd).toBe(tmpDir)
    })
  })

  describe("event emission", () => {
    it("emits chat.message (user) and chat.message (assistant) events to the log", async () => {
      const sessionId = "sess-event-test-1"
      const sessionFile = path.join(tmpDir, ".kody/sessions", `${sessionId}.jsonl`)
      fs.writeFileSync(sessionFile, JSON.stringify({
        role: "user",
        content: "Test message",
        timestamp: new Date().toISOString(),
        toolCalls: [],
      }) + "\n")

      mockResponseText = "Assistant response text"
      const chatCommand = await loadChatCommand()
      await chatCommand(["--session", sessionId, "--cwd", tmpDir])

      const eventLogFile = path.join(tmpDir, ".kody-engine", "event-log.json")
      expect(fs.existsSync(eventLogFile)).toBe(true)

      const entries = JSON.parse(fs.readFileSync(eventLogFile, "utf-8"))
      const chatEvents = entries.filter((e: any) =>
        e.event === "chat.message" || e.event === "chat.done",
      )

      expect(chatEvents.length).toBeGreaterThanOrEqual(3)
      expect(chatEvents.map((e: any) => e.event)).toContain("chat.message")
      expect(chatEvents.map((e: any) => e.event).lastIndexOf("chat.message")).toBeGreaterThan(0)
      expect(chatEvents.map((e: any) => e.event)).toContain("chat.done")
    })
  })

  describe("session persistence across runs", () => {
    it("appends to session file without overwriting previous messages", async () => {
      const sessionId = "sess-persist-test"
      const sessionFile = path.join(tmpDir, ".kody/sessions", `${sessionId}.jsonl`)

      const timestamp = new Date().toISOString()
      fs.writeFileSync(sessionFile, [
        JSON.stringify({ role: "user", content: "First message", timestamp, toolCalls: [] }),
        JSON.stringify({ role: "assistant", content: "First response", timestamp, toolCalls: [] }),
      ].join("\n") + "\n")

      mockResponseText = "Second response"
      const chatCommand = await loadChatCommand()
      await chatCommand(["--session", sessionId, "--cwd", tmpDir])

      const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").filter(Boolean)
      expect(lines).toHaveLength(3)
      const assistant2 = JSON.parse(lines[2])
      expect(assistant2.role).toBe("assistant")
      expect(assistant2.content).toBe("Second response")
    })
  })

  describe("tool calls in session", () => {
    it("captures tool_use blocks from Claude Code stream as completed tool calls", async () => {
      const sessionId = "sess-tools-test"
      const sessionFile = path.join(tmpDir, ".kody/sessions", `${sessionId}.jsonl`)
      fs.writeFileSync(sessionFile, JSON.stringify({
        role: "user",
        content: "Run the tests",
        timestamp: new Date().toISOString(),
        toolCalls: [],
      }) + "\n")

      spawnCalls = []
      mockResponseText = "Running npm test now"
      const chatCommand = await loadChatCommand()
      await chatCommand(["--session", sessionId, "--cwd", tmpDir])

      const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n")
      const assistantLine = lines.find((l) => JSON.parse(l).role === "assistant")
      const assistant = JSON.parse(assistantLine!)

      expect(assistant.role).toBe("assistant")
      expect(typeof assistant.content).toBe("string")
      expect(assistant.toolCalls).toBeDefined()
    })
  })
})
