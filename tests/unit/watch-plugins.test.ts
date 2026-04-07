import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { pipelineHealthPlugin } from "../../src/watch/plugins/pipeline-health/index"
import { securityScanPlugin } from "../../src/watch/plugins/security-scan/index"
import { configHealthPlugin } from "../../src/watch/plugins/config-health/index"
import { scanForHardcodedSecrets, scanForUnsafePatterns, scanForCommittedEnvFiles } from "../../src/watch/plugins/security-scan/scanner"
import type { WatchContext } from "../../src/watch/core/types"
import { JsonStateStore } from "../../src/watch/core/state"

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string

function createTestContext(overrides?: Partial<WatchContext>): WatchContext {
  return {
    repo: "test/repo",
    dryRun: false,
    state: new JsonStateStore("/dev/null"),
    github: {
      postComment: () => {},
      getIssue: () => ({ body: null, title: null }),
      getOpenIssues: () => [],
      createIssue: () => null,
      searchIssues: () => [],
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    runTimestamp: new Date().toISOString(),
    cycleNumber: 1,
    activityLog: 42,
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-watch-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ============================================================================
// Pipeline Health Plugin Tests
// ============================================================================

describe("pipeline-health plugin", () => {
  it("has correct metadata", () => {
    expect(pipelineHealthPlugin.name).toBe("pipeline-health")
    expect(pipelineHealthPlugin.schedule?.every).toBe(1)
  })

  it("returns empty when no tasks directory exists", async () => {
    const originalCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const ctx = createTestContext()
      const actions = await pipelineHealthPlugin.run(ctx)
      expect(actions).toHaveLength(0)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it("returns empty when all tasks are healthy", async () => {
    const originalCwd = process.cwd()
    const tasksDir = path.join(tmpDir, ".kody", "tasks", "task-1")
    fs.mkdirSync(tasksDir, { recursive: true })
    fs.writeFileSync(path.join(tasksDir, "status.json"), JSON.stringify({
      state: "completed",
      stages: {},
    }))

    process.chdir(tmpDir)
    try {
      const ctx = createTestContext()
      const actions = await pipelineHealthPlugin.run(ctx)
      expect(actions).toHaveLength(0)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it("detects failed tasks", async () => {
    const originalCwd = process.cwd()
    const tasksDir = path.join(tmpDir, ".kody", "tasks", "task-fail")
    fs.mkdirSync(tasksDir, { recursive: true })
    fs.writeFileSync(path.join(tasksDir, "status.json"), JSON.stringify({
      state: "failed",
      stages: { build: { state: "failed", error: "TypeScript compilation error" } },
    }))

    process.chdir(tmpDir)
    try {
      const ctx = createTestContext()
      const actions = await pipelineHealthPlugin.run(ctx)
      expect(actions.length).toBeGreaterThan(0)
      expect(actions[0].urgency).toBe("warning")
    } finally {
      process.chdir(originalCwd)
    }
  })

  it("detects stalled tasks", async () => {
    const originalCwd = process.cwd()
    const tasksDir = path.join(tmpDir, ".kody", "tasks", "task-stall")
    fs.mkdirSync(tasksDir, { recursive: true })

    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1 hour ago
    fs.writeFileSync(path.join(tasksDir, "status.json"), JSON.stringify({
      state: "running",
      startedAt: oldTime,
      stages: { build: { state: "running", startedAt: oldTime } },
    }))

    process.chdir(tmpDir)
    try {
      const ctx = createTestContext()
      const actions = await pipelineHealthPlugin.run(ctx)
      expect(actions.length).toBeGreaterThan(0)
    } finally {
      process.chdir(originalCwd)
    }
  })
})

// ============================================================================
// Security Scan Tests (Scanner)
// ============================================================================

describe("security scanner", () => {
  it("detects hardcoded secrets", () => {
    const srcDir = path.join(tmpDir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "config.ts"), `
      const key = "AKIAIOSFODNN7EXAMPLE"
    `)

    const findings = scanForHardcodedSecrets(tmpDir)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].rule).toBe("hardcoded-secret")
    expect(findings[0].severity).toBe("critical")
  })

  it("detects JWT tokens", () => {
    const srcDir = path.join(tmpDir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "auth.ts"), `
      const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    `)

    const findings = scanForHardcodedSecrets(tmpDir)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].message).toContain("JWT")
  })

  it("returns empty for clean code", () => {
    const srcDir = path.join(tmpDir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "clean.ts"), `
      const apiKey = process.env.API_KEY
      if (!apiKey) throw new Error("Missing API key")
    `)

    const findings = scanForHardcodedSecrets(tmpDir)
    expect(findings).toHaveLength(0)
  })

  it("detects eval usage", () => {
    const srcDir = path.join(tmpDir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "bad.ts"), `
      const result = eval("1+1")
    `)

    const findings = scanForUnsafePatterns(tmpDir)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].message).toContain("eval")
  })

  it("detects innerHTML assignment", () => {
    const srcDir = path.join(tmpDir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "dom.ts"), `
      element.innerHTML = userInput
    `)

    const findings = scanForUnsafePatterns(tmpDir)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].message).toContain("innerHTML")
  })

  it("returns empty when no src directory", () => {
    expect(scanForHardcodedSecrets(tmpDir)).toHaveLength(0)
    expect(scanForUnsafePatterns(tmpDir)).toHaveLength(0)
  })
})

describe("committed env files", () => {
  it("returns empty when .env is not tracked", () => {
    // No git repo = execFileSync will throw = not tracked
    const findings = scanForCommittedEnvFiles(tmpDir)
    expect(findings).toHaveLength(0)
  })
})

// ============================================================================
// Security Scan Plugin Tests
// ============================================================================

describe("security-scan plugin", () => {
  it("has correct metadata", () => {
    expect(securityScanPlugin.name).toBe("security-scan")
    expect(securityScanPlugin.schedule?.every).toBe(48)
  })

  it("returns empty for clean project", async () => {
    const originalCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const ctx = createTestContext()
      const actions = await securityScanPlugin.run(ctx)
      expect(actions).toHaveLength(0)
    } finally {
      process.chdir(originalCwd)
    }
  })
})

// ============================================================================
// Config Health Plugin Tests
// ============================================================================

describe("config-health plugin", () => {
  it("has correct metadata", () => {
    expect(configHealthPlugin.name).toBe("config-health")
    expect(configHealthPlugin.schedule?.every).toBe(48)
  })

  it("reports missing config", async () => {
    const originalCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const ctx = createTestContext()
      const actions = await configHealthPlugin.run(ctx)
      expect(actions.length).toBeGreaterThan(0)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it("passes with valid config", async () => {
    const originalCwd = process.cwd()
    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), JSON.stringify({
      github: { owner: "test", repo: "repo" },
      quality: { testUnit: "pnpm test" },
    }))
    fs.mkdirSync(path.join(tmpDir, ".kody"), { recursive: true })

    process.chdir(tmpDir)
    try {
      const ctx = createTestContext()
      const actions = await configHealthPlugin.run(ctx)
      // May still have findings for secrets check, but should not have config-exists or config-valid-json
      const configExists = actions.some((a) => a.detail.includes("not found"))
      expect(configExists).toBe(false)
    } finally {
      process.chdir(originalCwd)
    }
  })
})
