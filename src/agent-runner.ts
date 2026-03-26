import { spawn, execFileSync } from "child_process"
import type { AgentRunner, AgentResult, AgentRunnerOptions } from "./types.js"
import type { KodyConfig } from "./config.js"

const SIGKILL_GRACE_MS = 5000
const STDERR_TAIL_CHARS = 500

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
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL")
      }, SIGKILL_GRACE_MS)
    }, timeout)

    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      })
    })

    child.on("error", (err) => {
      clearTimeout(timer)
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

  const { code, stdout, stderr } = await waitForProcess(child, timeout)

  if (code === 0) {
    return { outcome: "completed", output: stdout }
  }

  return {
    outcome: code === null ? "timed_out" : "failed",
    error: `Exit code ${code}\n${stderr.slice(-STDERR_TAIL_CHARS)}`,
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
      return runSubprocess(
        "claude",
        [
          "--print",
          "--model", model,
          "--dangerously-skip-permissions",
          "--allowedTools", "Bash,Edit,Read,Write,Glob,Grep",
        ],
        prompt,
        timeout,
        options,
      )
    },

    async healthCheck(): Promise<boolean> {
      return checkCommand("claude", ["--version"])
    },
  }
}

// ─── OpenCode Runner ─────────────────────────────────────────────────────────

export function createOpenCodeRunner(): AgentRunner {
  return {
    async run(
      stageName: string,
      prompt: string,
      model: string,
      timeout: number,
      _taskDir: string,
      options?: AgentRunnerOptions,
    ): Promise<AgentResult> {
      const args = ["run", "--agent", "build"]
      if (model) {
        args.push("--model", model)
      }
      // Pipe prompt via stdin — --agent build enables full tool permissions
      return runSubprocess(
        "opencode",
        args,
        prompt,
        timeout,
        options,
      )
    },

    async healthCheck(): Promise<boolean> {
      return checkCommand("opencode", ["--version"])
    },
  }
}

// ─── Runner Factory ──────────────────────────────────────────────────────────

const RUNNER_FACTORIES: Record<string, () => AgentRunner> = {
  "claude-code": createClaudeCodeRunner,
  "opencode": createOpenCodeRunner,
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

  // Legacy single-runner fallback
  const runnerType = config.agent.runner ?? "claude-code"
  const factory = RUNNER_FACTORIES[runnerType]
  const defaultName = config.agent.defaultRunner ?? "claude"
  return { [defaultName]: factory ? factory() : createClaudeCodeRunner() }
}
