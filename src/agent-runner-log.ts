import * as fs from "fs"
import * as path from "path"
import type { FailureCategory } from "./types.js"

// ─── Ring Buffer ────────────────────────────────────────────────────────────

/**
 * Fixed-capacity FIFO buffer with eviction. Used to hold the last N SDK
 * messages in memory so we can dump them to a crash file on abort.
 */
export class RingBuffer<T> {
  private readonly buf: T[] = []
  private readonly cap: number
  constructor(capacity: number) {
    this.cap = Math.max(1, capacity)
  }
  push(item: T): void {
    this.buf.push(item)
    if (this.buf.length > this.cap) this.buf.shift()
  }
  snapshot(): T[] {
    return [...this.buf]
  }
  get size(): number {
    return this.buf.length
  }
}

// ─── Error Classification ───────────────────────────────────────────────────

/**
 * Classify an SDK query error into a granular failure category.
 * - timerFired: true when our wall-clock abort timer elapsed (signals real timeout)
 * - elapsedMs / timeoutMs: fallback check when timerFired is unknown
 */
export function classifySdkError(
  errorMessage: string,
  elapsedMs: number,
  timeoutMs: number,
  timerFired = false,
): FailureCategory {
  const msg = (errorMessage ?? "").toLowerCase()
  if (
    msg.includes("maximum number of turns") ||
    msg.includes("max_turns") ||
    msg.includes("max turns")
  ) {
    return "max_turns"
  }
  if (
    msg.includes("maximum budget") ||
    msg.includes("max_budget") ||
    msg.includes("max budget")
  ) {
    return "max_budget"
  }
  if (msg.includes("aborted") || msg.includes("aborterror")) {
    if (timerFired || elapsedMs >= timeoutMs) return "timed_out"
    return "aborted"
  }
  return "failed"
}

// ─── SDK Message Serialization ──────────────────────────────────────────────

export interface SerializedSdkMessage {
  ts: string
  type: string
  subtype?: string
  tool?: string
  toolInput?: string
  textPreview?: string
  textLength?: number
  tokens?: {
    input?: number
    output?: number
    cacheCreate?: number
    cacheRead?: number
  }
  raw?: string
}

const MAX_PREVIEW = 500
const MAX_TOOL_INPUT = 1000

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `… [+${s.length - max} chars]`
}

function mergePreview(existing: string | undefined, next: string): string {
  return existing ? `${existing}\n---\n${next}` : next
}

function serializeContentBlock(
  block: unknown,
  out: SerializedSdkMessage,
): void {
  if (!block || typeof block !== "object") return
  const b = block as Record<string, unknown>
  const type = typeof b.type === "string" ? b.type : undefined
  if (type === "text") {
    const text = typeof b.text === "string" ? b.text : ""
    out.textLength = (out.textLength ?? 0) + text.length
    out.textPreview = mergePreview(out.textPreview, truncate(text, 300))
  } else if (type === "tool_use") {
    out.tool = typeof b.name === "string" ? b.name : out.tool
    try {
      out.toolInput = truncate(JSON.stringify(b.input ?? {}), MAX_TOOL_INPUT)
    } catch {
      out.toolInput = "[unserializable]"
    }
  } else if (type === "tool_result") {
    const content = b.content
    if (typeof content === "string") {
      out.textLength = (out.textLength ?? 0) + content.length
      out.textPreview = mergePreview(out.textPreview, truncate(content, MAX_PREVIEW))
    } else if (Array.isArray(content)) {
      const joined = content
        .map((c) => {
          if (c && typeof c === "object") {
            const rec = c as Record<string, unknown>
            if (typeof rec.text === "string") return rec.text
          }
          return ""
        })
        .join("\n")
      out.textLength = (out.textLength ?? 0) + joined.length
      out.textPreview = mergePreview(out.textPreview, truncate(joined, MAX_PREVIEW))
    }
  }
}

function extractUsage(obj: Record<string, unknown>): SerializedSdkMessage["tokens"] | undefined {
  const usage =
    (typeof obj.usage === "object" && obj.usage !== null
      ? (obj.usage as Record<string, unknown>)
      : undefined) ??
    (typeof obj.message === "object" && obj.message !== null
      ? ((obj.message as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined)
  if (!usage) return undefined
  return {
    input: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
    output: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    cacheCreate:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : undefined,
    cacheRead:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : undefined,
  }
}

/**
 * Convert an arbitrary SDK message into a JSONL-safe record with truncated
 * previews. Defensive against unknown shapes; never throws.
 */
export function serializeSdkMessage(msg: unknown): SerializedSdkMessage {
  const out: SerializedSdkMessage = {
    ts: new Date().toISOString(),
    type: "unknown",
  }
  if (!msg || typeof msg !== "object") {
    out.raw = truncate(String(msg), MAX_PREVIEW)
    return out
  }
  const m = msg as Record<string, unknown>
  if (typeof m.type === "string") out.type = m.type
  if (typeof m.subtype === "string") out.subtype = m.subtype

  // Content blocks live directly on the message or nested under .message
  if (Array.isArray(m.content)) {
    for (const block of m.content) serializeContentBlock(block, out)
  } else if (m.message && typeof m.message === "object") {
    const inner = m.message as Record<string, unknown>
    if (Array.isArray(inner.content)) {
      for (const block of inner.content) serializeContentBlock(block, out)
    }
  }

  const tokens = extractUsage(m)
  if (tokens) out.tokens = tokens

  // Result messages often carry the full text under `.result`
  if (out.type === "result" && typeof m.result === "string") {
    out.textLength = m.result.length
    out.textPreview = mergePreview(out.textPreview, truncate(m.result, MAX_PREVIEW))
  }

  return out
}

// ─── Log File I/O ───────────────────────────────────────────────────────────

export interface AgentLog {
  path: string
  write: (msg: SerializedSdkMessage) => void
  close: () => void
}

/**
 * Open a per-stage JSONL agent log under `{taskDir}/agent-{stage}.jsonl`.
 * Returns a no-op writer if the filesystem rejects the open (non-fatal).
 */
export function openAgentLog(taskDir: string, stageName: string): AgentLog {
  // Some call sites (retrospective, nudge) pass an empty taskDir and don't
  // need a per-stage log. Return a no-op writer instead of failing noisily.
  if (!taskDir) {
    return { path: "", write() {}, close() {} }
  }
  const logPath = path.join(taskDir, `agent-${stageName}.jsonl`)
  let stream: fs.WriteStream | undefined
  try {
    fs.mkdirSync(taskDir, { recursive: true })
    stream = fs.createWriteStream(logPath, { flags: "w" })
    // Swallow late open/write errors (e.g. dir deleted under us in tests)
    // instead of bubbling up as an unhandled rejection.
    stream.on("error", () => {
      stream = undefined
    })
  } catch {
    // Non-fatal
  }
  return {
    path: logPath,
    write(msg) {
      if (!stream) return
      try { stream.write(JSON.stringify(msg) + "\n") } catch { /* ignore */ }
    },
    close() {
      if (!stream) return
      try { stream.end() } catch { /* ignore */ }
      stream = undefined
    },
  }
}

/**
 * Write the contents of a ring buffer to a crash file for postmortem.
 * Returns the path written, or undefined if the write failed.
 */
export function writeCrashDump(
  taskDir: string,
  stageName: string,
  messages: SerializedSdkMessage[],
  reason: string,
  category: FailureCategory,
  elapsedMs: number,
): string | undefined {
  if (!taskDir) return undefined
  const crashPath = path.join(taskDir, `agent-${stageName}.crash.jsonl`)
  try {
    fs.mkdirSync(taskDir, { recursive: true })
    const header: SerializedSdkMessage = {
      ts: new Date().toISOString(),
      type: "crash",
      subtype: category,
      raw: `${reason} (elapsed=${elapsedMs}ms, recentMessages=${messages.length})`,
    }
    const lines = [header, ...messages].map((m) => JSON.stringify(m)).join("\n") + "\n"
    fs.writeFileSync(crashPath, lines)
    return crashPath
  } catch {
    return undefined
  }
}
