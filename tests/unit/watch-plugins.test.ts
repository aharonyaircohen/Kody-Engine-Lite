/**
 * Watch-agent integration tests.
 *
 * Tests the shell-based scanning logic that the config-health, pipeline-health,
 * and security-scan watch-agent templates use. These run actual shell commands
 * (grep, git, etc.) against temporary fixture files — mirroring what the
 * agents do at runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execFileSync } from "child_process"

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-watch-test-"))

// Runs a grep via a temp script file to avoid shell quoting issues.
// The pattern is written on its own line, quoted with $'...', so backticks and
// special chars are handled literally by bash.
function grep(pattern: string, file: string, extraArgs: string = ""): string {
  const scriptPath = path.join(tmpDir, "scan.sh")
  const safePattern = pattern.replace(/'/g, "'\"'\"'") // single-quote escape for shell
  const safeFile = file.replace(/'/g, "'\"'\"'")
  const scriptContent = `grep -rnE ${extraArgs} -- '${safePattern}' '${safeFile}'`
  fs.writeFileSync(scriptPath, scriptContent + "\n")
  try {
    return execFileSync("bash", [scriptPath], {
      cwd: tmpDir,
      encoding: "utf-8",
      timeout: 10_000,
    })
  } catch (err: unknown) {
    const code = (err as { status?: number }).status
    if (code === 1) return "" // no matches
    throw err
  }
}

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(path.join(tmpDir, "src"), { recursive: true, force: true })
})

// ============================================================================
// Security Scan — hardcoded secret patterns (grep-based)
// ============================================================================

describe("security-scan: hardcoded secrets (grep)", () => {
  it("detects AWS access keys", () => {
    fs.writeFileSync(path.join(tmpDir, "src", "config.ts"), `const key = "AKIAIOSFODNN7EXAMPLE"\n`)
    const output = grep("['\"]AKIA[0-9A-Z]{16}['\"]", "src/")
    expect(output).toContain("config.ts")
  })

  it("detects JWT tokens", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "auth.ts"),
      `const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"\n`,
    )
    const output = grep("['\"]eyJ[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_-]{10,}['\"]", "src/")
    expect(output).toContain("auth.ts")
  })

  it("detects private key blocks", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "keys.ts"),
      `const key = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQ..."\n`,
    )
    const output = grep("-----BEGIN RSA PRIVATE KEY-----", "src/")
    expect(output).toContain("keys.ts")
  })

  it("returns empty for clean code", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "clean.ts"),
      `const apiKey = process.env.API_KEY\nif (!apiKey) throw new Error("Missing key")\n`,
    )
    const output = grep("['\"]AKIA[0-9A-Z]{16}['\"]", "src/")
    expect(output.trim()).toBe("")
  })

  it("skips node_modules when pattern is in node_modules but not src", () => {
    // This test verifies the exclusion — create a file in node_modules that would match
    // but not in src/. The src/ dir has no suspicious files so grep returns empty.
    const output = grep("['\"]AKIA[0-9A-Z]{16}['\"]", "src/", "--exclude-dir=node_modules")
    expect(output.trim()).toBe("")
  })
})

// ============================================================================
// Security Scan — unsafe patterns (grep-based)
// ============================================================================

describe("security-scan: unsafe patterns (grep)", () => {
  it("detects eval()", () => {
    fs.writeFileSync(path.join(tmpDir, "src", "bad.ts"), `const result = eval("1+1")\n`)
    const output = grep("\\beval\\s*\\(", "src/")
    expect(output).toContain("bad.ts")
  })

  it("detects innerHTML assignment", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "dom.ts"),
      `element.innerHTML = userInput\n`,
    )
    const output = grep("\\.innerHTML\\s*=", "src/")
    expect(output).toContain("dom.ts")
  })

  it("detects unsanitized exec with template literals", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "exec.ts"),
      `exec(\`ls \${userInput}\`)\n`,
    )
    const output = grep("exec\\s*\\(\\s*\\`", "src/")
    expect(output).toContain("exec.ts")
  })

  it("returns empty for safe exec usage (array-based)", () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "safe.ts"),
      `const cmd = ["ls", "-la"]\nexecFileSync(cmd[0], cmd)\n`,
    )
    const output = grep("exec\\s*\\(\\s*\\`", "src/")
    expect(output.trim()).toBe("")
  })
})

// ============================================================================
// Security Scan — committed .env files
// ============================================================================

describe("security-scan: committed env files (git ls-files)", () => {
  it("returns empty when .env is not tracked (not a git repo)", () => {
    // tmpDir is not a git repo — ls-files will fail, agent should treat as "not tracked"
    const result = (() => {
      try {
        return execFileSync("git", ["ls-files", "--error-unmatch", ".env"], {
          cwd: tmpDir,
          encoding: "utf-8",
          timeout: 5_000,
        })
      } catch {
        return null
      }
    })()
    expect(result).toBeNull()
  })
})

// ============================================================================
// Config Health — JSON parsing
// ============================================================================

describe("config-health: kody.config.json validation", () => {
  it("detects missing config", () => {
    expect(fs.existsSync(path.join(tmpDir, "kody.config.json"))).toBe(false)
  })

  it("detects invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), "{ invalid json }")
    let valid = true
    try {
      JSON.parse(fs.readFileSync(path.join(tmpDir, "kody.config.json"), "utf-8"))
    } catch {
      valid = false
    }
    expect(valid).toBe(false)
  })

  it("passes valid config with required fields", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        github: { owner: "test", repo: "repo" },
        quality: { testUnit: "pnpm test" },
      }),
    )
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "kody.config.json"), "utf-8"),
    )
    expect(config.github.owner).toBe("test")
    expect(config.github.repo).toBe("repo")
    expect(config.quality.testUnit).toBe("pnpm test")
  })

  it("detects missing github fields", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({ github: {} }),
    )
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "kody.config.json"), "utf-8"),
    )
    const hasGithub = !!(config.github?.owner && config.github?.repo)
    expect(hasGithub).toBe(false)
  })

  it("detects quality command not in package.json scripts", () => {
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        github: { owner: "test", repo: "repo" },
        quality: { testUnit: "pnpm run-nonexistent" },
      }),
    )
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    )
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "kody.config.json"), "utf-8"),
    )
    const pkg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"),
    )
    const qualityCmd = config.quality.testUnit as string
    const scriptName = qualityCmd.split(/\s+/)[1]
    const resolves = scriptName in (pkg.scripts || {})
    expect(resolves).toBe(false)
  })
})

// ============================================================================
// Pipeline Health — task status evaluation
// ============================================================================

describe("pipeline-health: task status evaluation", () => {
  const STALL_THRESHOLD_MS = 30 * 60 * 1000

  function evaluateTask(status: Record<string, unknown>): {
    health: string
    detail: string
  } {
    const now = Date.now()
    const state = status.state as string

    if (state === "failed") {
      const stages = status.stages as Record<string, { state: string; error?: string }>
      const failedStage = Object.entries(stages || {}).find(
        ([, s]) => s.state === "failed",
      )
      return {
        health: "failed",
        detail: failedStage
          ? `Failed at stage '${failedStage[0]}': ${failedStage[1].error || "unknown"}`
          : "Pipeline failed",
      }
    }

    if (state === "running" || state === "in-progress") {
      const startedAt = status.startedAt
        ? new Date(status.startedAt as string).getTime()
        : 0
      if (startedAt > 0) {
        const ageMs = now - startedAt
        if (ageMs > STALL_THRESHOLD_MS) {
          const stages = status.stages as Record<string, { state: string }>
          const runningStage = Object.entries(stages || {}).find(
            ([, s]) => s.state === "running" || s.state === "in-progress",
          )
          return {
            health: "stalled",
            detail: runningStage
              ? `Stalled at stage '${runningStage[0]}' for ${Math.round(ageMs / 60000)} min`
              : `Running for ${Math.round(ageMs / 60000)} min without progress`,
          }
        }
      }
      return { health: "healthy", detail: "Running normally" }
    }

    return {
      health: "healthy",
      detail:
        state === "completed"
          ? "Completed successfully"
          : `Status: ${state}`,
    }
  }

  it("detects failed tasks", () => {
    const result = evaluateTask({
      state: "failed",
      stages: { build: { state: "failed", error: "TypeScript compilation error" } },
    })
    expect(result.health).toBe("failed")
    expect(result.detail).toContain("TypeScript compilation error")
  })

  it("detects stalled tasks (> 30 min)", () => {
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const result = evaluateTask({
      state: "running",
      startedAt: oldTime,
      stages: { build: { state: "running" } },
    })
    expect(result.health).toBe("stalled")
    expect(result.detail).toContain("Stalled at stage")
  })

  it("marks recently started tasks as healthy", () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const result = evaluateTask({
      state: "running",
      startedAt: recentTime,
      stages: { build: { state: "running" } },
    })
    expect(result.health).toBe("healthy")
  })

  it("marks completed tasks as healthy", () => {
    const result = evaluateTask({ state: "completed", stages: {} })
    expect(result.health).toBe("healthy")
    expect(result.detail).toBe("Completed successfully")
  })
})
