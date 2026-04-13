/**
 * `kody chat` — Interactive chat session entry point.
 *
 * Runs Claude Code with session history from `.kody/sessions/<sessionId>.jsonl`,
 * emits chat events (chat.message, chat.done, chat.error) via the event system.
 *
 * Supports two modes:
 *   - Default: process --message or existing session, then exit
 *   - --poll: stay alive and poll for incoming messages (long-running workflow)
 *
 * Usage:
 *   kody chat --session <sessionId> --message <text>    # One-shot: message, respond, exit
 *   kody chat --session <sessionId> --poll              # Long-running: poll for messages
 */

import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import { getArg } from "../cli.js"
import { getProjectConfig } from "../../config.js"
import { getAnthropicApiKeyOrDummy } from "../../config.js"
import { anyStageNeedsProxy } from "../../config.js"
import { logger } from "../../logger.js"
import { ensureLiteLlmProxyForChat } from "../../cli/litellm.js"
import { emit } from "../../event-system/index.js"
import { upsertChatSession, enqueueChatMessage, pollInstruction } from "../../event-system/store/action-state.js"

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

interface StreamChunk {
  type: string
  [key: string]: unknown
}

// ─── Session helpers ──────────────────────────────────────────────────────────

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

// ─── Claude Code runner ────────────────────────────────────────────────────────

interface RunResult {
  content: string
  toolCalls: ToolCall[]
  timestamp: string
}

async function runClaudeCode(
  prompt: string,
  model: string,
  projectDir: string,
  usesProxy: boolean,
): Promise<RunResult> {
  const claudeArgs = [
    "--print",
    "--verbose",
    "--model", model,
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

  const textParts: string[] = []
  const toolCalls: ToolCall[] = []

  const child = spawn("claude", claudeArgs, {
    cwd: projectDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })

  child.stdin?.write(prompt, () => child.stdin?.end())

  await new Promise<void>((resolve, reject) => {
    let done = false

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n")
      for (const raw of lines) {
        if (!raw.trim()) continue

        try {
          const data = JSON.parse(raw) as StreamChunk

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

          if (data.type === "result") {
            const result = data as Record<string, unknown>
            if (textParts.length === 0 && result.result) {
              const resultText = result.result as string
              textParts.push(resultText)
              process.stdout.write(resultText)
            }
            for (const tc of toolCalls) {
              if (tc.status === "in_progress") tc.status = "completed"
            }
            if (!done) {
              done = true
              resolve()
            }
          }
        } catch {
          // Skip non-JSON lines
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

  for (const tc of toolCalls) {
    if (tc.status === "in_progress") tc.status = "completed"
  }

  return {
    content: textParts.join(""),
    toolCalls,
    timestamp: new Date().toISOString(),
  }
}

// ─── Process one user message ─────────────────────────────────────────────────

async function processMessage(
  runId: string,
  sessionId: string,
  projectDir: string,
  userMessage: string,
  model: string,
  usesProxy: boolean,
): Promise<void> {
  const timestamp = new Date().toISOString()
  const userMsg: SessionMessage = {
    role: "user",
    content: userMessage,
    timestamp,
    toolCalls: [],
  }

  // Write user message to session file
  appendToSession(sessionId, projectDir, userMsg)

  // Emit user event
  await emit("chat.message", {
    runId,
    sessionId,
    role: "user",
    content: userMessage,
    timestamp,
    toolCalls: [],
  })

  // Build prompt from session history
  const messages = readSession(sessionId, projectDir)
  const lastUserMsg = messages[messages.length - 1]
  const priorMessages = messages.slice(0, -1)
  const prompt = buildPrompt(priorMessages) + `\nHuman: ${lastUserMsg.content}\n\nAssistant:`

  // Run Claude Code
  const result = await runClaudeCode(prompt, model, projectDir, usesProxy)

  // Emit assistant event
  await emit("chat.message", {
    runId,
    sessionId,
    role: "assistant",
    content: result.content,
    timestamp: result.timestamp,
    toolCalls: result.toolCalls,
  })

  // Append assistant response to session file
  appendToSession(sessionId, projectDir, {
    role: "assistant",
    content: result.content,
    timestamp: result.timestamp,
    toolCalls: result.toolCalls,
  })
}

// ─── Polling loop ────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runPollingLoop(
  runId: string,
  sessionId: string,
  projectDir: string,
  model: string,
  usesProxy: boolean,
  pollIntervalMs: number,
  idleTimeoutMs: number,
): Promise<void> {
  // Register this session so Dashboard can find it
  upsertChatSession(runId, sessionId)

  logger.info(`[chat:polling] session=${sessionId} idleTimeout=${idleTimeoutMs}ms`)

  // lastMessageAt = when the last message was successfully processed.
  // idleSince  = when we first started waiting with no pending instruction.
  //               null means we are not currently in an idle window.
  let lastMessageAt = Date.now()
  let idleSince: number | null = null

  while (true) {
    // Poll for new messages
    const result = pollInstruction(runId, sessionId)

    if (result.cancel) {
      logger.info(`[chat:polling] cancelled by=${result.cancelledBy}`)
      await emit("action.cancelled", { runId, cancelledBy: result.cancelledBy ?? undefined })
      await emit("chat.done", { runId, sessionId })
      return
    }

    if (result.instruction) {
      // Got a message — reset idle tracking and process it
      idleSince = null
      lastMessageAt = Date.now()
      logger.info(`[chat:polling] processing message: "${result.instruction.slice(0, 60)}..."`)

      try {
        await processMessage(runId, sessionId, projectDir, result.instruction, model, usesProxy)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.error(`[chat:polling] message failed: ${error}`)
        await emit("chat.error", { runId, sessionId, error })
      }

      // After processing, loop immediately to check for more messages
      continue
    }

    // No instruction received. Start or extend the idle window.
    if (idleSince === null) idleSince = Date.now()

    // Check idle timeout BEFORE sleeping: if we've been idle for > idleTimeoutMs, exit now
    // without waiting for another poll interval.
    if (Date.now() - idleSince > idleTimeoutMs) {
      logger.info(`[chat:polling] idle timeout reached (${idleTimeoutMs}ms)`)
      await emit("chat.done", { runId, sessionId })
      return
    }

    // Wait before polling again
    await sleep(pollIntervalMs)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function chatCommand(rawArgs: string[]): Promise<void> {
  const sessionId = getArg(rawArgs, "--session")
  const message = getArg(rawArgs, "--message")
  const model = getArg(rawArgs, "--model")
  const cwd = getArg(rawArgs, "--cwd")
  const isPolling = rawArgs.includes("--poll")

  if (!sessionId) {
    console.error(
      "Usage: kody chat --session <sessionId> [--message <text>] [--model <model>] [--cwd <dir>] [--poll]",
    )
    process.exit(1)
  }

  const projectDir = cwd ? path.resolve(cwd) : process.cwd()
  const config = getProjectConfig()
  const effectiveModel =
    model ??
    config.agent.default?.model ??
    Object.values(config.agent.modelMap)[0] ??
    "claude-sonnet-4-6"
  const usesProxy = anyStageNeedsProxy(config)

  const runId = `chat-${sessionId}-${Date.now()}`

  // Start LiteLLM proxy if needed
  const { kill: killProxy } = await ensureLiteLlmProxyForChat(config, projectDir)

  try {
    if (isPolling) {
      // Long-running mode: poll the action-state queue for incoming messages
      const pollIntervalMs = Number(getArg(rawArgs, "--poll-interval") ?? "5000")
      const idleTimeoutMs = Number(getArg(rawArgs, "--poll-timeout") ?? "360000")
      await runPollingLoop(runId, sessionId, projectDir, effectiveModel, usesProxy, pollIntervalMs, idleTimeoutMs)
    } else if (message) {
      // One-shot mode: --message provided — append it, process, emit done
      await processMessage(runId, sessionId, projectDir, message, effectiveModel, usesProxy)
      await emit("chat.done", { runId, sessionId })
    } else {
      // One-shot mode: use last user message already in session file.
      // Do NOT call processMessage (it would re-append the message).
      // Build prompt from prior messages, run Claude, append assistant response only.
      const messages = readSession(sessionId, projectDir)
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
      if (!lastUserMsg) {
        console.error("No user message found in session. Use --message to send a message.")
        process.exit(1)
      }
      const priorMessages = messages.filter((m) => m !== lastUserMsg)
      const prompt = buildPrompt(priorMessages) + `\nHuman: ${lastUserMsg.content}\n\nAssistant:`

      await emit("chat.message", {
        runId,
        sessionId,
        role: "user",
        content: lastUserMsg.content,
        timestamp: lastUserMsg.timestamp,
        toolCalls: [],
      })

      const result = await runClaudeCode(prompt, effectiveModel, projectDir, usesProxy)

      await emit("chat.message", {
        runId,
        sessionId,
        role: "assistant",
        content: result.content,
        timestamp: result.timestamp,
        toolCalls: result.toolCalls,
      })

      appendToSession(sessionId, projectDir, {
        role: "assistant",
        content: result.content,
        timestamp: result.timestamp,
        toolCalls: result.toolCalls,
      })

      await emit("chat.done", { runId, sessionId })
    }
  } finally {
    if (killProxy) killProxy()
    console.error("\n[chat] Session complete.")
  }
}
