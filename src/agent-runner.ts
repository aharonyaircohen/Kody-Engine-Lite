import { spawn, execFileSync } from "child_process"
import type { AgentRunner, AgentResult, AgentRunnerOptions } from "./types.js"
import type { KodyConfig } from "./config.js"
import type { PathLike } from "fs"
import { createWriteStream, mkdirSync } from "fs"

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
    outcome: code === null ? "timed_out" : "failed",
    error: `Exit code ${code}\n${errDetail}`,
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

export function createClaudeCodeRunner(): AgentRunner {
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

export function createSdkRunner(): AgentRunner {
  return {
    async run(
      _stageName: string,
      prompt: string,
      model: string,
      timeout: number,
      taskDir: string,
      options?: AgentRunnerOptions,
    ): Promise<AgentResult> {
      const abortController = new AbortController()
      const timer = setTimeout(() => abortController.abort(), timeout)

      const baseTools = "Bash,Edit,Read,Write,Glob,Grep"

      let output = ""
      let structuredOutput: unknown = null

      try {
        const result = query({
          prompt,
          options: {
            model,
            cwd: taskDir,
            effort: "high",
            sessionId: options?.sessionId,
            resume: options?.resumeSession ? options.sessionId : undefined,
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
          if (msg.type === "result" && msg.subtype === "success") {
            output = msg.result ?? ""
            structuredOutput = msg.structured_output ?? null
          }
        }

        clearTimeout(timer)
        return { outcome: "completed", output, structuredOutput }
      } catch (e) {
        clearTimeout(timer)
        const err = e instanceof Error ? e.message : String(e)
        if (err.includes("maximum number of turns")) {
          return { outcome: "timed_out", output, error: "maxTurns" }
        }
        if (err.includes("maximum budget")) {
          return { outcome: "timed_out", output, error: "maxBudget" }
        }
        return { outcome: "failed", output, error: err }
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

  // Single-runner default
  const defaultName = config.agent.defaultRunner ?? "claude"
  const defaultFactory = RUNNER_FACTORIES[defaultName] ?? createClaudeCodeRunner
  return { [defaultName]: defaultFactory() }
}
