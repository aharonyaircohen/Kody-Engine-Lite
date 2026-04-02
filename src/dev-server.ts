import { spawn, type ChildProcess } from "child_process"
import { logger } from "./logger.js"

export interface DevServerOptions {
  command: string
  url: string
  readyTimeout?: number
  envVars?: Record<string, string>
}

export interface DevServerHandle {
  ready: boolean
  url: string
  pid: number | undefined
  stop: () => void
}

async function pollReady(url: string, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok || (res.status >= 200 && res.status < 400)) return true
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/**
 * Start the dev server as a child process with a hard readiness timeout.
 * Returns a handle with `ready` (whether the server responded) and `stop()`.
 * The process is fully detached so it won't block the engine.
 */
export async function startDevServer(opts: DevServerOptions): Promise<DevServerHandle> {
  const timeout = opts.readyTimeout ?? 30
  const [cmd, ...args] = opts.command.split(/\s+/)

  let child: ChildProcess
  try {
    child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      shell: true,
      env: { ...process.env, ...opts.envVars },
    })
  } catch (err) {
    logger.warn(`  Dev server failed to spawn: ${err instanceof Error ? err.message : String(err)}`)
    return { ready: false, url: opts.url, pid: undefined, stop: () => {} }
  }

  // Capture stdout and stderr for diagnostics
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })

  // Check if process died immediately
  let exited = false
  child.on("exit", () => { exited = true })

  // Unref so it doesn't keep the engine alive
  child.unref()

  const ready = await pollReady(opts.url, timeout)

  if (!ready) {
    if (exited) {
      logger.warn(`  Dev server exited before becoming ready`)
    } else {
      logger.warn(`  Dev server did not respond within ${timeout}s at ${opts.url}`)
    }
    if (stdout) {
      logger.warn(`  Dev server stdout (last 500 chars): ${stdout.slice(-500)}`)
    }
    if (stderr) {
      logger.warn(`  Dev server stderr (last 500 chars): ${stderr.slice(-500)}`)
    }
  }

  const pid = child.pid
  const stop = () => {
    try {
      if (pid) process.kill(-pid, "SIGTERM")
    } catch {
      // already dead
    }
    try {
      child.kill("SIGTERM")
    } catch {
      // already dead
    }
  }

  return { ready, url: opts.url, pid, stop }
}
