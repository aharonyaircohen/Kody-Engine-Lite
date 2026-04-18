import { spawn } from "child_process"
import type { KodyLeanConfig } from "./config.js"

export interface VerifyResult {
  ok: boolean
  failed: string[]
  details: Record<string, { exitCode: number; durationMs: number; tail: string }>
}

const TAIL_CHARS = 4000
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000

interface RunResult {
  exitCode: number
  durationMs: number
  tail: string
}

function runCommand(command: string, cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1", CI: process.env.CI ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const buffers: Buffer[] = []
    let totalSize = 0
    const collect = (chunk: Buffer): void => {
      buffers.push(chunk)
      totalSize += chunk.length
      while (totalSize > TAIL_CHARS * 4 && buffers.length > 1) {
        totalSize -= buffers[0]!.length
        buffers.shift()
      }
    }

    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL") }, 5000)
    }, COMMAND_TIMEOUT_MS)

    child.on("exit", (code) => {
      clearTimeout(timer)
      const tail = Buffer.concat(buffers).toString("utf-8").slice(-TAIL_CHARS)
      resolve({ exitCode: code ?? -1, durationMs: Date.now() - start, tail })
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, durationMs: Date.now() - start, tail: err.message })
    })
  })
}

export async function verifyAll(config: KodyLeanConfig, cwd?: string): Promise<VerifyResult> {
  const commands: { name: string; cmd: string }[] = []
  if (config.quality.typecheck) commands.push({ name: "typecheck", cmd: config.quality.typecheck })
  if (config.quality.testUnit) commands.push({ name: "test", cmd: config.quality.testUnit })
  if (config.quality.lint) commands.push({ name: "lint", cmd: config.quality.lint })

  const failed: string[] = []
  const details: Record<string, RunResult> = {}

  for (const { name, cmd } of commands) {
    const result = await runCommand(cmd, cwd)
    details[name] = result
    if (result.exitCode !== 0) failed.push(name)
  }

  return { ok: failed.length === 0, failed, details }
}

export function summarizeFailure(result: VerifyResult): string {
  const lines = [`verify failed: ${result.failed.join(", ")}`]
  for (const name of result.failed) {
    const d = result.details[name]
    if (!d) continue
    lines.push(`\n--- ${name} (exit ${d.exitCode}, ${(d.durationMs / 1000).toFixed(1)}s) ---`)
    lines.push(d.tail)
  }
  return lines.join("\n")
}
