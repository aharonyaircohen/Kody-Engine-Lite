/**
 * `kody chat` — Interactive chat session entry point.
 *
 * Reads session history from `.kody/sessions/<sessionId>.jsonl`,
 * runs Claude Code with the conversation context, and emits
 * chat events (chat.message, chat.done, chat.error) to the dashboard
 * via HTTP POST to the dashboard hook endpoint.
 *
 * Usage:
 *   kody chat --session <sessionId> --message <text>  # CLI: message creates session file
 *   kody chat --session <sessionId>                  # Workflow: uses existing session file
 */

import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import { getArg } from "../cli.js"
import { getProjectConfig } from "../../config.js"
import { getAnthropicApiKeyOrDummy } from "../../config.js"
import { anyStageNeedsProxy, getLitellmUrl } from "../../config.js"
import { logger } from "../../logger.js"
import { ensureLiteLlmProxyForChat } from "../../cli/litellm.js"

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
  projectDir: string,
): Promise<void> {
  const dashboardUrl = getDashboardUrl()
  const sessionId = payload.sessionId as string

  // Also write to local event file so SSE can poll it
  const sessionDir = path.join(projectDir, ".kody", "events")
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

// ─── Types (shared) ──────────────────────────────────────────────────────────

interface StreamChunk {
  type: string
  [key: string]: unknown
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function chatCommand(rawArgs: string[]): Promise<void> {
  const sessionId = getArg(rawArgs, "--session")
  const message = getArg(rawArgs, "--message")
  const model = getArg(rawArgs, "--model")
  const cwd = getArg(rawArgs, "--cwd")

  if (!sessionId) {
    console.error("Usage: kody chat --session <sessionId> [--message <text>] [--model <model>] [--cwd <dir>]")
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

  // Start LiteLLM proxy if needed (mirrors entry.ts behavior)
  const { kill: killProxy } = await ensureLiteLlmProxyForChat(config, projectDir)

  // Read session history
  let messages = readSession(sessionId, projectDir)

  // If --message is provided, append it as a new user message
  let lastUserMsg: SessionMessage | undefined
  if (message) {
    const timestamp = new Date().toISOString()
    const newMsg: SessionMessage = {
      role: "user",
      content: message,
      timestamp,
      toolCalls: [],
    }
    appendToSession(sessionId, projectDir, newMsg)
    // Re-read to get full history including the new message
    messages = readSession(sessionId, projectDir)
    lastUserMsg = newMsg
  } else {
    // Get the last user message from existing session
    lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) {
      console.error("No user message found in session. Use --message to send a message.")
      process.exit(1)
    }
  }

  // Build conversation context for Claude Code
  const priorMessages = messages.filter((m) => m !== lastUserMsg)
  const prompt = buildPrompt(priorMessages) + `\nHuman: ${lastUserMsg.content}\n\nAssistant:`

  // Build Claude Code args
  const claudeArgs = [
    "--print",
    "--verbose",
    "--model", effectiveModel,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
  ]

  const env: Record<string, string | undefined> = {
    ...process.env,
  }
  if (usesProxy) {
    env.ANTHROPIC_BASE_URL = "http://localhost:4000"
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
  }, runId, projectDir)

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
  const textParts: string[] = []
  await new Promise<void>((resolve, reject) => {
    let done = false

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n")
      for (const raw of lines) {
        if (!raw.trim()) continue

        try {
          const data = JSON.parse(raw) as StreamChunk

          // Handle assistant message with content blocks
          if (data.type === "assistant" && data.message) {
            const message = data.message as Record<string, unknown>
            const content = message.content as Array<Record<string, unknown>> | undefined
            if (content) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  const text = block.text as string
                  textParts.push(text)
                  process.stdout.write(text)
                } else if (block.type === "tool_use") {
                  toolCalls.push({
                    name: (block.name as string) ?? "",
                    arguments: (block.input as Record<string, unknown>) ?? {},
                    status: "in_progress",
                  })
                }
              }
            }
          }

          // Handle result — marks the end of the stream
          if (data.type === "result") {
            const result = data as Record<string, unknown>
            // If no streaming text was captured, use the result text
            if (textParts.length === 0 && result.result) {
              const resultText = result.result as string
              textParts.push(resultText)
              process.stdout.write(resultText)
            }
            // Mark all in-progress tool calls as completed
            for (const tc of toolCalls) {
              if (tc.status === "in_progress") tc.status = "completed"
            }
            if (!done) {
              done = true
              resolve()
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
      if (!done) {
        done = true
        if (code !== 0 && code !== null) {
          reject(new Error(`Claude Code exited with code ${code}`))
        } else {
          resolve()
        }
      }
    })

    child.on("error", reject)
  })

  assistantText = textParts.join("")

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
  }, runId, projectDir)

  // Append assistant response to session file
  appendToSession(sessionId, projectDir, {
    role: "assistant",
    content: assistantText,
    timestamp: assistantTimestamp,
    toolCalls,
  })

  // Emit done
  await emitEvent("chat.done", { runId, sessionId }, runId, projectDir)

  // Stop LiteLLM proxy if we started it
  if (killProxy) killProxy()

  console.error("\n[chat] Session complete.")
}
