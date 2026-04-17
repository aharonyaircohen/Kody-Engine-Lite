import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  RingBuffer,
  classifySdkError,
  serializeSdkMessage,
  openAgentLog,
  writeCrashDump,
  nextAttemptNumber,
  type SerializedSdkMessage,
} from "../../src/agent-runner-log.js"

describe("RingBuffer", () => {
  it("stores items up to capacity without dropping", () => {
    const rb = new RingBuffer<number>(3)
    rb.push(1)
    rb.push(2)
    rb.push(3)
    expect(rb.snapshot()).toEqual([1, 2, 3])
    expect(rb.size).toBe(3)
  })

  it("evicts the oldest item when capacity is exceeded (FIFO)", () => {
    const rb = new RingBuffer<number>(3)
    rb.push(1)
    rb.push(2)
    rb.push(3)
    rb.push(4)
    expect(rb.snapshot()).toEqual([2, 3, 4])
    expect(rb.size).toBe(3)
  })

  it("snapshot returns a defensive copy (mutating it doesn't affect buffer)", () => {
    const rb = new RingBuffer<number>(3)
    rb.push(1)
    const snap = rb.snapshot()
    snap.push(999)
    expect(rb.snapshot()).toEqual([1])
  })

  it("clamps capacity to at least 1", () => {
    const rb = new RingBuffer<number>(0)
    rb.push(1)
    rb.push(2)
    expect(rb.snapshot()).toEqual([2])
  })
})

describe("classifySdkError", () => {
  it("classifies 'maximum number of turns' as max_turns", () => {
    expect(classifySdkError("Error: maximum number of turns reached", 1000, 60_000)).toBe("max_turns")
  })

  it("classifies 'maximum budget' as max_budget", () => {
    expect(classifySdkError("maximum budget exceeded: 5 USD", 1000, 60_000)).toBe("max_budget")
  })

  it("classifies aborted-with-timer-fired as timed_out", () => {
    expect(classifySdkError("Query aborted by AbortController", 60_000, 60_000, true)).toBe("timed_out")
  })

  it("classifies aborted-without-timer as external abort", () => {
    expect(classifySdkError("Query aborted by AbortController", 5_000, 60_000, false)).toBe("aborted")
  })

  it("classifies aborted with elapsed >= timeout as timed_out even when timerFired flag missing", () => {
    expect(classifySdkError("AbortError", 60_500, 60_000, false)).toBe("timed_out")
  })

  it("falls back to failed for unknown errors", () => {
    expect(classifySdkError("ECONNREFUSED 127.0.0.1:4000", 5_000, 60_000)).toBe("failed")
  })

  it("is case-insensitive", () => {
    expect(classifySdkError("MAXIMUM NUMBER OF TURNS", 100, 60_000)).toBe("max_turns")
    expect(classifySdkError("AbortError: signal is aborted", 100, 60_000, true)).toBe("timed_out")
  })

  it("handles empty error string as failed", () => {
    expect(classifySdkError("", 100, 60_000)).toBe("failed")
  })
})

describe("serializeSdkMessage", () => {
  it("records type and subtype from top-level fields", () => {
    const s = serializeSdkMessage({ type: "result", subtype: "success", result: "done" })
    expect(s.type).toBe("result")
    expect(s.subtype).toBe("success")
    expect(s.textPreview).toBe("done")
  })

  it("extracts tool_use name and input", () => {
    const s = serializeSdkMessage({
      type: "assistant",
      content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
    })
    expect(s.type).toBe("assistant")
    expect(s.tool).toBe("Bash")
    expect(s.toolInput).toContain("ls -la")
  })

  it("extracts text content length and truncated preview", () => {
    const longText = "a".repeat(1000)
    const s = serializeSdkMessage({
      type: "assistant",
      content: [{ type: "text", text: longText }],
    })
    expect(s.textLength).toBe(1000)
    expect(s.textPreview).toContain("a")
    // Preview is truncated at 300 chars for text blocks; appended " …" suffix
    expect((s.textPreview ?? "").length).toBeLessThan(400)
  })

  it("extracts tool_result string content", () => {
    const s = serializeSdkMessage({
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "abc", content: "file contents" }],
    })
    expect(s.textPreview).toBe("file contents")
  })

  it("extracts tool_result array content", () => {
    const s = serializeSdkMessage({
      type: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "abc",
          content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
        },
      ],
    })
    expect(s.textPreview).toContain("line1")
    expect(s.textPreview).toContain("line2")
  })

  it("extracts usage from message.usage", () => {
    const s = serializeSdkMessage({
      type: "assistant",
      message: {
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 },
      },
    })
    expect(s.tokens).toEqual({
      input: 100,
      output: 50,
      cacheCreate: undefined,
      cacheRead: 25,
    })
  })

  it("returns a well-formed record for unknown/null msg", () => {
    const s = serializeSdkMessage(null)
    expect(s.type).toBe("unknown")
    expect(s.raw).toBeDefined()
  })

  it("handles unserializable input gracefully (circular)", () => {
    const circular: Record<string, unknown> = { type: "assistant" }
    circular.self = circular
    const toolUse = { type: "tool_use", name: "Bad", input: circular }
    const s = serializeSdkMessage({ type: "assistant", content: [toolUse] })
    expect(s.tool).toBe("Bad")
    expect(s.toolInput).toBe("[unserializable]")
  })

  it("sets a timestamp", () => {
    const s = serializeSdkMessage({ type: "result", subtype: "success" })
    expect(s.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe("nextAttemptNumber", () => {
  let tmpDir: string
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-attempt-")) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns 1 when no prior log exists", () => {
    expect(nextAttemptNumber(tmpDir, "plan")).toBe(1)
  })

  it("returns 1 when taskDir does not exist", () => {
    expect(nextAttemptNumber(path.join(tmpDir, "does-not-exist"), "plan")).toBe(1)
  })

  it("increments past the highest existing log file", () => {
    fs.writeFileSync(path.join(tmpDir, "agent-plan.1.jsonl"), "")
    fs.writeFileSync(path.join(tmpDir, "agent-plan.2.jsonl"), "")
    expect(nextAttemptNumber(tmpDir, "plan")).toBe(3)
  })

  it("considers both .N.jsonl and .N.crash.jsonl when picking next", () => {
    fs.writeFileSync(path.join(tmpDir, "agent-plan.1.crash.jsonl"), "")
    expect(nextAttemptNumber(tmpDir, "plan")).toBe(2)
  })

  it("is scoped per stage (doesn't cross-count other stages)", () => {
    fs.writeFileSync(path.join(tmpDir, "agent-build.5.jsonl"), "")
    expect(nextAttemptNumber(tmpDir, "plan")).toBe(1)
  })

  it("handles stage names containing regex-special characters safely", () => {
    // "review-fix" is real. Construct a more adversarial one just in case.
    fs.writeFileSync(path.join(tmpDir, "agent-review-fix.1.jsonl"), "")
    expect(nextAttemptNumber(tmpDir, "review-fix")).toBe(2)
  })
})

describe("openAgentLog", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-agent-log-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes one JSONL line per message", async () => {
    const log = openAgentLog(tmpDir, "taskify")
    log.write({ ts: "t1", type: "assistant", textPreview: "hello" })
    log.write({ ts: "t2", type: "result", subtype: "success" })
    log.close()
    // Wait for stream flush
    await new Promise((r) => setTimeout(r, 20))

    const content = fs.readFileSync(log.path, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first.type).toBe("assistant")
    expect(first.textPreview).toBe("hello")
  })

  it("returns no-op writer when taskDir is empty", () => {
    const log = openAgentLog("", "anything")
    // Should not throw
    log.write({ ts: "t1", type: "assistant" })
    log.close()
    expect(log.path).toBe("")
    expect(log.attempt).toBe(0)
  })

  it("uses stage name and attempt number in the file name", () => {
    const log = openAgentLog(tmpDir, "review-fix")
    log.close()
    expect(log.path).toBe(path.join(tmpDir, "agent-review-fix.1.jsonl"))
    expect(log.attempt).toBe(1)
  })

  it("does NOT truncate a previous attempt when called a second time for the same stage", async () => {
    const first = openAgentLog(tmpDir, "plan")
    first.write({ ts: "t1", type: "assistant", textPreview: "attempt-1-content" })
    first.close()
    await new Promise((r) => setTimeout(r, 20))

    const second = openAgentLog(tmpDir, "plan")
    second.write({ ts: "t2", type: "assistant", textPreview: "attempt-2-content" })
    second.close()
    await new Promise((r) => setTimeout(r, 20))

    expect(first.path).not.toBe(second.path)
    expect(first.attempt).toBe(1)
    expect(second.attempt).toBe(2)

    // Both files exist and preserve their own content
    const firstContent = fs.readFileSync(first.path, "utf-8")
    expect(firstContent).toContain("attempt-1-content")
    const secondContent = fs.readFileSync(second.path, "utf-8")
    expect(secondContent).toContain("attempt-2-content")
  })
})

describe("writeCrashDump", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-crash-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes header + messages as JSONL with attempt-suffixed filename", () => {
    const messages: SerializedSdkMessage[] = [
      { ts: "t1", type: "assistant", tool: "Bash", toolInput: "ls" },
      { ts: "t2", type: "user", textPreview: "ok" },
    ]
    const crashPath = writeCrashDump(tmpDir, "build", 1, messages, "timed out", "timed_out", 120_000)
    expect(crashPath).toBe(path.join(tmpDir, "agent-build.1.crash.jsonl"))

    const content = fs.readFileSync(crashPath!, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(3) // header + 2 messages

    const header = JSON.parse(lines[0])
    expect(header.type).toBe("crash")
    expect(header.subtype).toBe("timed_out")
    expect(header.raw).toContain("timed out")
    expect(header.raw).toContain("120000")
    expect(header.raw).toContain("attempt=1")
    expect(header.raw).toContain("recentMessages=2")

    const msg1 = JSON.parse(lines[1])
    expect(msg1.tool).toBe("Bash")
  })

  it("puts the attempt number in the filename so multiple failures don't overwrite", () => {
    const p1 = writeCrashDump(tmpDir, "plan", 1, [], "x", "failed", 100)
    const p2 = writeCrashDump(tmpDir, "plan", 2, [], "y", "failed", 200)
    expect(p1).toBe(path.join(tmpDir, "agent-plan.1.crash.jsonl"))
    expect(p2).toBe(path.join(tmpDir, "agent-plan.2.crash.jsonl"))
    expect(fs.existsSync(p1!)).toBe(true)
    expect(fs.existsSync(p2!)).toBe(true)
  })

  it("returns undefined on empty taskDir", () => {
    const crashPath = writeCrashDump("", "build", 1, [], "n/a", "failed", 0)
    expect(crashPath).toBeUndefined()
  })
})
