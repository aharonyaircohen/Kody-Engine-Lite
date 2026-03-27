import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import { logger } from "../logger.js"

export async function checkLitellmHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

export async function tryStartLitellm(
  url: string,
  projectDir: string,
): Promise<ReturnType<typeof import("child_process").spawn> | null> {
  const configPath = path.join(projectDir, "litellm-config.yaml")
  if (!fs.existsSync(configPath)) {
    logger.warn("litellm-config.yaml not found — cannot start proxy")
    return null
  }

  // Extract port from URL
  const portMatch = url.match(/:(\d+)/)
  const port = portMatch ? portMatch[1] : "4000"

  // Check if litellm is installed
  try {
    execFileSync("litellm", ["--version"], { timeout: 5000, stdio: "pipe" })
  } catch {
    try {
      execFileSync("python3", ["-m", "litellm", "--version"], { timeout: 5000, stdio: "pipe" })
    } catch {
      logger.warn("litellm not installed (pip install 'litellm[proxy]')")
      return null
    }
  }

  logger.info(`Starting LiteLLM proxy on port ${port}...`)

  // Determine command
  let cmd: string
  let args: string[]
  try {
    execFileSync("litellm", ["--version"], { timeout: 5000, stdio: "pipe" })
    cmd = "litellm"
    args = ["--config", configPath, "--port", port]
  } catch {
    cmd = "python3"
    args = ["-m", "litellm", "--config", configPath, "--port", port]
  }

  const { spawn } = await import("child_process")
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env as Record<string, string>,
  })

  // Wait for health
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await checkLitellmHealth(url)) {
      logger.info(`LiteLLM proxy ready at ${url}`)
      return child
    }
  }

  logger.warn("LiteLLM proxy failed to start within 60s")
  child.kill()
  return null
}
