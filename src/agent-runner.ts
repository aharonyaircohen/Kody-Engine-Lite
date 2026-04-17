import { spawn, execFileSync } from "child_process"
import type { AgentRunner, AgentResult, AgentRunnerOptions } from "./types.js"
import type { KodyConfig } from "./config.js"
import type { PathLike } from "fs"
import { createWriteStream, mkdirSync } from "fs"
import { logger } from "./logger.js"
import {
  RingBuffer,
  classifySdkError,
  openAgentLog,
  serializeSdkMessage,
  writeCrashDump,
  type SerializedSdkMessage,
} from "./agent-runner-log.js"

const SIGKILL_GRACE_MS = 5000
const STDERR_TAIL_CHARS = 2000

function writeStdin(
  child: ReturnType<typeof spawn>,
  prompt: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin) {
      resolve()
      return
    }
    child.stdin.write(prompt, (err) => {
      if (err) reject(err)
      else {
        child.stdin!.end()
        resolve()
      }
    })
  })
}

function waitForProcess(
  child: ReturnType<typeof spawn>,
  timeout: number,
  logFilePath?: PathLike,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    let logStream: ReturnType<typeof createWriteStream> | undefined
    if (logFilePath) {
      try {
        const dir = logFilePath.toString().replace(/[/\\][^/\\]*$/, "")
        mkdirSync(dir, { recursive: true })
        logStream = createWriteStream(logFilePath, { flags: "w" })
      } catch {
        // Non-fatal: proceed without file logging
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      logStream?.write(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk)
      logStream?.write(chunk)
    })

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL")
      }, SIGKILL_GRACE_MS)
    }, timeout)

    child.on("exit", (code) => {
      clearTimeout(timer)
      logStream?.end()
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      })
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      logStream?.end()
      resolve({ code: -1, stdout: "", stderr: err.message })
    })
  })
}

async function runSubprocess(
  command: string,
  args: string[],
  prompt: string,
  timeout: number,
  options?: AgentRunnerOptions,
  logFilePath?: PathLike,
): Promise<AgentResult> {
  const child = spawn(command, args, {
    cwd: options?.cwd ?? process.cwd(),
    env: {
      ...process.env,
      SKIP_BUILD: "1",
      SKIP_HOOKS: "1",
      ...options?.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })

  try {
    await writeStdin(child, prompt)
  } catch (err) {
    return {
      outcome: "failed",
      error: `Failed to send prompt: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const { code, stdout, stderr } = await waitForProcess(child, timeout, logFilePath)

  if (code === 0) {
    return { outcome: "completed", output: stdout }
  }

  const errDetail = stderr.slice(-STDERR_TAIL_CHARS) || stdout.slice(-STDERR_TAIL_CHARS)
  return {
    outcome: code === null || code === 143 ? "timed_out" : "failed",
    error: `Exit code ${code}${code === 143 ? " (SIGTERM — internal timeout)" : ""}\n${errDetail}`,
  }
}

function checkCommand(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { timeout: 10_000, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

// ─── Claude Code Runner ──────────────────────────────────────────────────────

/**
 * @deprecated Use SDK runner via kody.config.json agent.runners: { type: "sdk" }.
 * The Claude Code subprocess runner is harder to test, lacks structured output,
 * and has divergent MCP/allowedTools behavior. This function will be removed in a
 * future version.
 */
export function createClaudeCodeRunner(): AgentRunner {
  logger.warn(
    "[kody] DEPRECATED: createClaudeCodeRunner is deprecated. " +
    "Set agent.runners in kody.config.json to use the SDK runner instead. " +
    "See: https://docs.kody.dev/litellm",
  )
  return {
    async run(
      _stageName: string,
      prompt: string,
      model: string,
      timeout: number,
      _taskDir: string,
      options?: AgentRunnerOptions,
    ): Promise<AgentResult> {
      const args = [
        "--print",
        "--model", model,
        "--dangerously-skip-permissions",
      ]

      // Built-in tools that pipeline agents need
      const baseTools = "Bash,Edit,Read,Write,Glob,Grep"

      if (options?.mcpConfigJson) {
        args.push("--mcp-config", options.mcpConfigJson)
        // MCP tool names are dynamic (mcp__{server}__{tool}) and cannot be
        // enumerated at config time. Claude Code CLI does not support wildcard
        // patterns in --allowedTools, so we must omit the flag entirely when
        // MCP servers are present. This gives the agent access to all tools
        // (including Agent, WebFetch, WebSearch). The prompt controls behavior;
        // --dangerously-skip-permissions is already in use.
        // TODO: revisit if Claude Code CLI adds prefix/glob support for --allowedTools
      } else {
        args.push("--allowedTools", baseTools)
      }

      if (options?.sessionId) {
        if (options.resumeSession) {
          args.push("--resume", options.sessionId)
        } else {
          args.push("--session-id", options.sessionId)
        }
      }

      // Persist Claude Code session transcript to disk for debugging
      const logFilePath = options?.agentLogFile

      return runSubprocess("claude", args, prompt, timeout, options, logFilePath)
    },

    async healthCheck(): Promise<boolean> {
      return checkCommand("claude", ["--version"])
    },
  }
}

// ─── SDK Runner ───────────────────────────────────────────────────────────────

import { query, type AgentDefinition, type OutputFormat } from "@anthropic-ai/claude-agent-sdk"

const CRASH_BUFFER_CAPACITY = 50
const STALL_INTERVAL_MS = 60_000
const SOFT_TIMEOUT_RATIO = 0.8

export function createSdkRunner(): AgentRunner {
  return {
    async run(
      stageName: string,
      prompt: string,
      model: string,
      timeout: number,
      taskDir: string,
      options?: AgentRunnerOptions,
    ): Promise<AgentResult> {
      const abortController = new AbortController()
      let timerFired = false
      const startMs = Date.now()
      const timer = setTimeout(() => {
        timerFired = true
        abortController.abort()
      }, timeout)

      const baseTools = "Bash,Edit,Read,Write,Glob,Grep"

      // Observability: per-stage JSONL log + ring buffer for crash dumps.
      // stageName is used in the file path so concurrent stages don't clash.
      const safeStageName = stageName || "agent"
      const agentLog = openAgentLog(taskDir, safeStageName)
      const recentMessages = new RingBuffer<SerializedSdkMessage>(CRASH_BUFFER_CAPACITY)

      // Stall / soft-timeout observability: warn when the SDK goes quiet or
      // when we're close to the hard timeout, with a snapshot of the last
      // known activity so postmortems don't have to guess.
      let lastMessageAt = startMs
      let lastActivity: { type: string; tool?: string } = { type: "(awaiting first message)" }
      const describeActivity = (): string => {
        const nowMs = Date.now()
        const sinceMsg = Math.round((nowMs - lastMessageAt) / 1000)
        const total = Math.round((nowMs - startMs) / 1000)
        const toolPart = lastActivity.tool ? ` tool=${lastActivity.tool}` : ""
        return `last=${lastActivity.type}${toolPart} sinceMsg=${sinceMsg}s totalElapsed=${total}s`
      }
      const stallInterval = setInterval(() => {
        if (Date.now() - lastMessageAt > STALL_INTERVAL_MS) {
          logger.warn(
            `  [${safeStageName}] no SDK activity for ${Math.round((Date.now() - lastMessageAt) / 1000)}s — ${describeActivity()}`,
          )
        }
      }, STALL_INTERVAL_MS)
      // Soft warning at 80% of budget so postmortems see a warning before the
      // hard abort, with the last activity captured at that moment.
      const softTimer = setTimeout(() => {
        logger.warn(
          `  [${safeStageName}] 80% of timeout budget used — ${describeActivity()}`,
        )
      }, Math.floor(timeout * SOFT_TIMEOUT_RATIO))

      let output = ""
      let structuredOutput: unknown = null

      try {
        // Session resume is intentionally disabled at the SDK boundary. The
        // upstream @anthropic-ai/claude-agent-sdk query path consistently
        // crashes ("Claude Code process exited with code 1" with zero messages)
        // whenever a sessionId that has been used earlier in the same Node
        // process is passed back in — seen across all retried stages in both
        // local and CI runs. We ignore the caller's sessionId/resumeSession
        // so every query() starts fresh; re-enable when the SDK bug is fixed.
        // (The caller-side SESSION_GROUP plumbing in stages/agent.ts is left
        //  in place as a no-op; cleanup tracked as a separate follow-up.)
        const result = query({
          prompt,
          options: {
            model,
            cwd: taskDir,
            effort: "high",
            sessionId: undefined,
            resume: undefined,
            allowedTools: options?.allowedTools ?? (options?.mcpConfigJson ? undefined : baseTools.split(",")),
            mcpServers: options?.mcpConfigJson ? JSON.parse(options.mcpConfigJson).mcpServers : undefined,
            permissionMode: options?.allowedTools ? "plan" : "bypassPermissions",
            maxTurns: options?.maxTurns,
            maxBudgetUsd: options?.maxBudgetUsd,
            agents: options?.agents as Record<string, AgentDefinition> | undefined,
            outputFormat: options?.outputFormat as OutputFormat | undefined,
            env: {
              ...process.env,
              SKIP_BUILD: "1",
              SKIP_HOOKS: "1",
              HUSKY: "0",
              ...options?.env,
            },
            abortController,
          },
        })

        for await (const msg of result) {
          // Observability: record every message, not just the final result.
          const serialized = serializeSdkMessage(msg)
          agentLog.write(serialized)
          recentMessages.push(serialized)
          lastMessageAt = Date.now()
          lastActivity = { type: serialized.type, tool: serialized.tool }

          if (msg.type === "result" && msg.subtype === "success") {
            output = msg.result ?? ""
            structuredOutput = msg.structured_output ?? null
          }
        }

        clearTimeout(timer)
        clearTimeout(softTimer)
        clearInterval(stallInterval)
        agentLog.close()
        return { outcome: "completed", output, structuredOutput }
      } catch (e) {
        clearTimeout(timer)
        clearTimeout(softTimer)
        clearInterval(stallInterval)
        const err = e instanceof Error ? e.message : String(e)
        const elapsedMs = Date.now() - startMs
        const category = classifySdkError(err, elapsedMs, timeout, timerFired)

        const crashPath = writeCrashDump(
          taskDir,
          safeStageName,
          agentLog.attempt,
          recentMessages.snapshot(),
          err,
          category,
          elapsedMs,
        )
        if (crashPath) {
          logger.warn(
            `  [${safeStageName}] agent crash dump written: ${crashPath} — ${describeActivity()}`,
          )
        }
        agentLog.close()

        // Map granular category to the coarse AgentResult.outcome consumed by
        // stage executors. Callers that need the fine-grained category read
        // failureCategory directly.
        const outcome: AgentResult["outcome"] =
          category === "timed_out" ? "timed_out" : "failed"

        return {
          outcome,
          output,
          error: `[${category}] ${err}`,
          failureCategory: category,
        }
      }
    },

    async healthCheck(): Promise<boolean> {
      // SDK doesn't have a direct health check; check if the package is importable
      return true
    },
  }
}

// ─── Runner Factory ──────────────────────────────────────────────────────────

const RUNNER_FACTORIES: Record<string, () => AgentRunner> = {
  "claude-code": createClaudeCodeRunner,
  sdk: createSdkRunner,
}

export function createRunners(config: KodyConfig): Record<string, AgentRunner> {
  // New multi-runner config
  if (config.agent.runners && Object.keys(config.agent.runners).length > 0) {
    const runners: Record<string, AgentRunner> = {}
    for (const [name, runnerConfig] of Object.entries(config.agent.runners)) {
      const factory = RUNNER_FACTORIES[runnerConfig.type]
      if (factory) {
        runners[name] = factory()
      }
    }
    return runners
  }

  // Single-runner default — SDK runner is now the default. The legacy name
  // "claude" (used by existing configs and our own fallback chain) silently
  // routes to the SDK factory so users who never set defaultRunner get the
  // observability features without reconfiguring. Users who still need the
  // deprecated subprocess runner can opt in via defaultRunner: "claude-code"
  // or agent.runners: { foo: { type: "claude-code" } }.
  const defaultName = config.agent.defaultRunner ?? "sdk"
  const defaultFactory = RUNNER_FACTORIES[defaultName] ?? createSdkRunner
  return { [defaultName]: defaultFactory() }
}
