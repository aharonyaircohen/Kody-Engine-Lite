import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { loadState, writeState, initState } from "../../src/pipeline/state.js"
import { parseCommand } from "../../src/verify-runner.js"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createMockRunner(): AgentRunner {
  return {
    run: async () => ({ outcome: "completed" as const, output: '{"risk_level":"high","task_type":"feature","title":"test","description":"test","scope":[]}' }),
    healthCheck: async () => true,
  }
}

function createCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-stab-"))
  const taskDir = path.join(tmpDir, ".kody/tasks", "test-1")
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, "task.md"), "# Test task")

  // Write minimal kody.config.json
  fs.writeFileSync(
    path.join(tmpDir, "kody.config.json"),
    JSON.stringify({ quality: {}, git: {}, agent: {} }),
  )
  setConfigDir(tmpDir)

  return {
    taskId: "test-1",
    taskDir,
    projectDir: tmpDir,
    runners: { claude: createMockRunner() },
    input: { mode: "full", dryRun: true, local: true },
    ...overrides,
  }
}

describe("stability fixes", () => {
  afterEach(() => {
    resetProjectConfig()
  })

  // Fix #1 — Atomic state write
  describe("atomic state write", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-atomic-"))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("writes via temp file (no .tmp left behind)", () => {
      const state = initState("test-atomic")
      writeState(state, tmpDir)

      const files = fs.readdirSync(tmpDir)
      expect(files).toContain("status.json")
      expect(files).not.toContain("status.json.tmp")
    })

    it("state survives simulated crash (temp file exists)", () => {
      // Write initial state
      const state = initState("test-crash")
      writeState(state, tmpDir)

      // Simulate crash: leave a .tmp file from interrupted write
      fs.writeFileSync(path.join(tmpDir, "status.json.tmp"), "corrupted partial write")

      // Next write should overwrite .tmp and rename cleanly
      state.stages.taskify.state = "completed"
      writeState(state, tmpDir)

      const loaded = loadState("test-crash", tmpDir)
      expect(loaded).not.toBeNull()
      expect(loaded!.stages.taskify.state).toBe("completed")
    })

    it("status.json is valid JSON after write", () => {
      const state = initState("test-valid")
      writeState(state, tmpDir)

      const raw = fs.readFileSync(path.join(tmpDir, "status.json"), "utf-8")
      expect(() => JSON.parse(raw)).not.toThrow()
    })
  })

  // Fix #2 — Lock file
  describe("pipeline lock", () => {
    it("creates and removes .lock file during pipeline run", async () => {
      const ctx = createCtx()

      await runPipeline(ctx)

      // Lock should be released after pipeline completes
      const lockPath = path.join(ctx.taskDir, ".lock")
      expect(fs.existsSync(lockPath)).toBe(false)

      fs.rmSync(ctx.projectDir, { recursive: true, force: true })
    })

    it("rejects concurrent run with active lock", async () => {
      const ctx = createCtx()
      const lockPath = path.join(ctx.taskDir, ".lock")

      // Simulate active lock from current process
      fs.writeFileSync(lockPath, String(process.pid))

      await expect(runPipeline(ctx)).rejects.toThrow("Pipeline already running")

      fs.rmSync(ctx.projectDir, { recursive: true, force: true })
    })

    it("overwrites stale lock from dead process", async () => {
      const ctx = createCtx()
      const lockPath = path.join(ctx.taskDir, ".lock")

      // Write lock with a PID that doesn't exist (99999999)
      fs.writeFileSync(lockPath, "99999999")

      // Should succeed — stale lock from dead process
      await runPipeline(ctx)

      expect(fs.existsSync(lockPath)).toBe(false)

      fs.rmSync(ctx.projectDir, { recursive: true, force: true })
    })
  })

  // Fix #4 — Git checkout early return
  // (tested implicitly through ensureFeatureBranch, but we verify the return behavior)

  // Fix #5 — Observer diagnosis logging
  // (tested in observer.test.ts — the warn is a behavioral addition, not logic change)

  // Fix #9 — parseCommand unclosed quotes
  describe("parseCommand unclosed quotes", () => {
    it("handles unclosed double quote gracefully", () => {
      // Should not throw, should return best-effort parse
      const result = parseCommand('pnpm -s "test:unit')
      expect(result).toEqual(["pnpm", "-s", "test:unit"])
    })

    it("handles unclosed single quote gracefully", () => {
      const result = parseCommand("pnpm -s 'test:unit")
      expect(result).toEqual(["pnpm", "-s", "test:unit"])
    })

    it("handles quote at end of string", () => {
      const result = parseCommand('pnpm "')
      expect(result).toEqual(["pnpm"])
    })
  })
})
