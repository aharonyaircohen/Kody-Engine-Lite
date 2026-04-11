/**
 * `kody-engine chat` — Interactive chat session entry point.
 *
 * Reads session history from `.kody/sessions/<sessionId>.jsonl`,
 * runs Claude Code with the conversation context, and emits
 * chat events (chat.message, chat.done, chat.error) to the dashboard
 * via HTTP POST to the dashboard hook endpoint.
 *
 * Usage:
 *   kody-engine chat --session <sessionId> [--model <model>] [--cwd <dir>]
 */

import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import { fileURLToPath } from "url"

import { getArg } from "../cli.js"
import { getProjectConfig } from "../../config.js"
import { getLitellmUrl } from "../../config.js"
import { getAnthropicApiKeyOrDummy } from "../../config.js"
import { anyStageNeedsProxy } from "../../config.js"
import { logger } from "../../logger.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..", "..")

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionMessage {
  role: "user" | "assistant"
  content: string
  timestamp: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  name: string
  arguments: unknown
  result?: unknown
  status: "completed" | "failed" | "in_progress"
}

// ─── Event emission ───────────────────────────────────────────────────────────

function getDashboardUrl(): string | null {
  const endpoints = process.env.KODY_DASHBOARD_ENDPOINTS
  if (!endpoints) return null
  try {
    const parsed = JSON.parse(endpoints) as Array<{ url: string }>
    return parsed[0]?.url ?? null
  } catch {
    return null
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function emitEvent(
  name: string,
  payload: Record<string, unknown>,
  runId: string,
): Promise<void> {
  const dashboardUrl = getDashboardUrl()
  const sessionId = payload.sessionId as string

  // Also write to local event file so SSE can poll it
  const sessionDir = path.join(PKG_ROOT, ".kody", "events")
  fs.mkdirSync(sessionDir, { recursive: true })
  const eventFile = path.join(sessionDir, `${sessionId}.jsonl`)
  const entry = {
    id: generateId(),
    runId,
    event: name,
    payload,
    emittedAt: new Date().toISOString(),
  }
  fs.appendFileSync(eventFile, JSON.stringify(entry) + "\n")

  // POST to dashboard hook
  if (dashboardUrl) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      await fetch(`${dashboardUrl}/api/kody/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: name, payload, channel: "chat" }),
        signal: controller.signal,
      })
      clearTimeout(timeout)
    } catch (err) {
      logger.debug(`[chat] dashboard emit error (non-fatal): ${err}`)
    }
  }
}

// ─── Session reading ──────────────────────────────────────────────────────────

function readSession(sessionId: string, projectDir: string): SessionMessage[] {
  const sessionFile = path.join(projectDir, ".kody", "sessions", `${sessionId}.jsonl`)
  if (!fs.existsSync(sessionFile)) return []

  const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n")
  const messages: SessionMessage[] = []
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as SessionMessage)
    } catch {
      // Skip malformed lines
    }
  }
  return messages
}

function appendToSession(
  sessionId: string,
  projectDir: string,
  message: SessionMessage,
): void {
  const sessionDir = path.join(projectDir, ".kody", "sessions")
  fs.mkdirSync(sessionDir, { recursive: true })
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`)
  fs.appendFileSync(sessionFile, JSON.stringify(message) + "\n")
}

// ─── Prompt building ──────────────────────────────────────────────────────────

function buildPrompt(messages: SessionMessage[]): string {
  if (messages.length === 0) return ""

  const parts: string[] = []
  for (const msg of messages) {
    const label = msg.role === "user" ? "Human" : "Assistant"
    parts.push(`\n${label}: ${msg.content}`)
  }
  parts.push("\nAssistant:")
  return parts.join("")
}

// ─── Streaming JSON parser ────────────────────────────────────────────────────

interface StreamChunk {
  type: string
  [key: string]: unknown
}

async function parseStreamChunks(
  stdout: NodeJS.ReadableStream,
  onText: (text: string) => void,
  onToolCall: (tc: ToolCall) => void,
  onDone: () => void,
): Promise<void> {
  let buffer = ""

  const stream = stdout as NodeJS.ReadableStream & {
    on(event: string, cb: (chunk: Buffer) => void): void
  }

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? "" // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim() || line.trim() === "data: ") continue
        // Remove "data: " prefix if present
        const jsonStr = line.startsWith("data: ")
          ? line.slice(6)
          : line
        if (!jsonStr.trim()) continue

        try {
          const data = JSON.parse(jsonStr) as StreamChunk
          if (data.type === "content_block_start" && (data.content_block as Record<string, unknown>)?.type === "tool_use") {
            const block = data.content_block as Record<string, unknown>
            const input = block.input as Record<string, unknown> | undefined
            onToolCall({
              name: (block.name as string) ?? "",
              arguments: input ?? {},
              status: "in_progress",
            })
          } else if (data.type === "content_block_delta" && data.delta) {
            const delta = data.delta as Record<string, unknown>
            if (delta.type === "text_delta" && delta.text) {
              onText(delta.text as string)
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              // For tool input streaming, we handle it on completion
            }
          } else if (data.type === "message_delta" && data.usage) {
            onDone()
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    })

    stream.on("end", () => {
      if (buffer.trim()) {
        try {
          const jsonStr = buffer.startsWith("data: ")
            ? buffer.slice(6)
            : buffer
          const data = JSON.parse(jsonStr) as StreamChunk
          if (data.type === "message_delta") onDone()
        } catch {
          // ignore
        }
      }
      resolve()
    })

    stream.on("error", reject)
  })
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function chatCommand(rawArgs: string[]): Promise<void> {
  const sessionId = getArg(rawArgs, "--session")
  const model = getArg(rawArgs, "--model")
  const cwd = getArg(rawArgs, "--cwd")

  if (!sessionId) {
    console.error("Usage: kody-engine chat --session <sessionId> [--model <model>] [--cwd <dir>]")
    process.exit(1)
  }

  // Resolve working directory
  const projectDir = cwd ? path.resolve(cwd) : process.cwd()

  // Load config for defaults
  const config = getProjectConfig()
  const effectiveModel =
    model ??
    config.agent.default?.model ??
    Object.values(config.agent.modelMap)[0] ??
    "claude-sonnet-4-6"

  const runId = `chat-${sessionId}-${Date.now()}`
  const usesProxy = anyStageNeedsProxy(config)

  // Read session history
  const messages = readSession(sessionId, projectDir)

  // Get the last user message as the prompt
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
  if (!lastUserMsg) {
    console.error("No user message found in session")
    process.exit(1)
  }

  // Build conversation context for Claude Code
  const priorMessages = messages.filter((m) => m !== lastUserMsg)
  const prompt = buildPrompt(priorMessages) + `\nHuman: ${lastUserMsg.content}\n\nAssistant:`

  // Build Claude Code args
  const claudeArgs = [
    "--print",
    "--model", effectiveModel,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
  ]

  const env: Record<string, string | undefined> = {
    ...process.env,
  }
  if (usesProxy) {
    env.ANTHROPIC_BASE_URL = getLitellmUrl()
    env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  // Emit user message event
  await emitEvent("chat.message", {
    runId,
    sessionId,
    role: "user",
    content: lastUserMsg.content,
    timestamp: lastUserMsg.timestamp,
    toolCalls: [],
  }, runId)

  // Run Claude Code
  let assistantText = ""
  let toolCalls: ToolCall[] = []

  const child = spawn("claude", claudeArgs, {
    cwd: projectDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })

  child.stdin?.write(prompt, () => child.stdin?.end())

  // Parse streaming output
  await new Promise<void>((resolve, reject) => {
    const textParts: string[] = []

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n")
      for (const raw of lines) {
        if (!raw.trim() || raw === "data: ") continue
        const jsonStr = raw.startsWith("data: ") ? raw.slice(6) : raw
        if (!jsonStr.trim()) continue

        try {
          const data = JSON.parse(jsonStr) as StreamChunk

          if (data.type === "content_block_start") {
            const block = data.content_block as Record<string, unknown>
            if (block?.type === "tool_use") {
              toolCalls.push({
                name: (block.name as string) ?? "",
                arguments: (block.input as Record<string, unknown>) ?? {},
                status: "in_progress",
              })
            }
          } else if (data.type === "content_block_delta") {
            const delta = data.delta as Record<string, unknown>
            if (delta?.type === "text_delta" && delta.text) {
              const text = delta.text as string
              textParts.push(text)
              process.stdout.write(text)
            } else if (delta?.type === "input_json_delta" && delta.partial_json) {
              // Tool input streaming — update last tool call's arguments
              const last = toolCalls[toolCalls.length - 1]
              if (last && last.status === "in_progress") {
                // Accumulate partial JSON
                const existing = typeof last.arguments === "string"
                  ? last.arguments
                  : JSON.stringify(last.arguments)
                last.arguments = existing + (delta.partial_json as string)
              }
            }
          } else if (data.type === "message_stop") {
            // Mark all in-progress tool calls as completed
            for (const tc of toolCalls) {
              if (tc.status === "in_progress") tc.status = "completed"
            }
          }
        } catch {
          // Skip non-JSON lines (plain text output)
        }
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk)
    })

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Claude Code exited with code ${code}`))
      } else {
        assistantText = textParts.join("")
        resolve()
      }
    })

    child.on("error", reject)
  })

  const assistantTimestamp = new Date().toISOString()

  // Mark tool calls as completed
  for (const tc of toolCalls) {
    if (tc.status === "in_progress") tc.status = "completed"
  }

  // Emit assistant message event
  await emitEvent("chat.message", {
    runId,
    sessionId,
    role: "assistant",
    content: assistantText,
    timestamp: assistantTimestamp,
    toolCalls,
  }, runId)

  // Append assistant response to session file
  appendToSession(sessionId, projectDir, {
    role: "assistant",
    content: assistantText,
    timestamp: assistantTimestamp,
    toolCalls,
  })

  // Emit done
  await emitEvent("chat.done", { runId, sessionId }, runId)

  console.error("\n[chat] Session complete.")
}
