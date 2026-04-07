import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import {
  appendRunRecord,
  readRunHistory,
  formatRunHistoryForPrompt,
  findParentRunId,
} from "../../src/run-history.js"
import type { RunRecord } from "../../src/run-history.js"

function makeRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    runId: "42-260405-120000",
    issueNumber: 42,
    command: "run",
    startedAt: "2026-04-05T12:00:00.000Z",
    completedAt: "2026-04-05T12:05:00.000Z",
    outcome: "completed",
    stagesCompleted: ["taskify", "plan", "build", "verify", "review", "ship"],
    ...overrides,
  }
}

describe("run-history", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-run-history-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("appendRunRecord", () => {
    it("creates .kody/runs/ directory and appends record", () => {
      const record = makeRecord()
      appendRunRecord(tmpDir, record)

      const filePath = path.join(tmpDir, ".kody", "runs", "42.jsonl")
      expect(fs.existsSync(filePath)).toBe(true)

      const content = fs.readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(content.trim())
      expect(parsed.runId).toBe("42-260405-120000")
      expect(parsed.outcome).toBe("completed")
    })

    it("appends multiple records to the same file", () => {
      appendRunRecord(tmpDir, makeRecord({ runId: "run-1" }))
      appendRunRecord(tmpDir, makeRecord({ runId: "run-2" }))
      appendRunRecord(tmpDir, makeRecord({ runId: "run-3" }))

      const filePath = path.join(tmpDir, ".kody", "runs", "42.jsonl")
      const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean)
      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0]).runId).toBe("run-1")
      expect(JSON.parse(lines[2]).runId).toBe("run-3")
    })

    it("uses runId as filename when no issueNumber", () => {
      const record = makeRecord({ issueNumber: undefined, runId: "standalone-run" })
      appendRunRecord(tmpDir, record)

      const filePath = path.join(tmpDir, ".kody", "runs", "standalone-run.jsonl")
      expect(fs.existsSync(filePath)).toBe(true)
    })
  })

  describe("readRunHistory", () => {
    it("returns empty array when no file exists", () => {
      const records = readRunHistory(tmpDir, 99)
      expect(records).toEqual([])
    })

    it("reads all records from JSONL file", () => {
      appendRunRecord(tmpDir, makeRecord({ runId: "run-1" }))
      appendRunRecord(tmpDir, makeRecord({ runId: "run-2", outcome: "failed", failedStage: "build" }))

      const records = readRunHistory(tmpDir, 42)
      expect(records).toHaveLength(2)
      expect(records[0].runId).toBe("run-1")
      expect(records[1].outcome).toBe("failed")
      expect(records[1].failedStage).toBe("build")
    })

    it("skips malformed lines gracefully", () => {
      const dir = path.join(tmpDir, ".kody", "runs")
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, "42.jsonl")
      fs.writeFileSync(filePath, `${JSON.stringify(makeRecord({ runId: "good" }))}\nnot-json\n${JSON.stringify(makeRecord({ runId: "also-good" }))}\n`)

      const records = readRunHistory(tmpDir, 42)
      expect(records).toHaveLength(2)
      expect(records[0].runId).toBe("good")
      expect(records[1].runId).toBe("also-good")
    })

    it("handles empty file", () => {
      const dir = path.join(tmpDir, ".kody", "runs")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "42.jsonl"), "")

      const records = readRunHistory(tmpDir, 42)
      expect(records).toEqual([])
    })
  })

  describe("formatRunHistoryForPrompt", () => {
    it("returns empty string for no records", () => {
      expect(formatRunHistoryForPrompt([])).toBe("")
    })

    it("formats single completed run", () => {
      const records = [makeRecord()]
      const formatted = formatRunHistoryForPrompt(records)
      expect(formatted).toContain("## Previous Runs on This Issue")
      expect(formatted).toContain("Run 1: 42-260405-120000 (run)")
      expect(formatted).toContain("completed")
      expect(formatted).toContain("IMPORTANT: Review what was tried before")
    })

    it("formats failed run with error and stages", () => {
      const records = [
        makeRecord({
          outcome: "failed",
          failedStage: "build",
          failedError: "TypeScript compilation error",
          stagesCompleted: ["taskify", "plan"],
        }),
      ]
      const formatted = formatRunHistoryForPrompt(records)
      expect(formatted).toContain("failed at build")
      expect(formatted).toContain("Error: TypeScript compilation error")
      expect(formatted).toContain("Stages completed: taskify, plan")
    })

    it("includes feedback when present", () => {
      const records = [
        makeRecord({ feedback: "fix the TypeScript errors" }),
      ]
      const formatted = formatRunHistoryForPrompt(records)
      expect(formatted).toContain('Feedback: "fix the TypeScript errors"')
    })

    it("limits to maxRuns most recent records", () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        makeRecord({ runId: `run-${i}` }),
      )
      const formatted = formatRunHistoryForPrompt(records, 3)
      expect(formatted).not.toContain("run-0")
      expect(formatted).not.toContain("run-6")
      expect(formatted).toContain("run-7")
      expect(formatted).toContain("run-8")
      expect(formatted).toContain("run-9")
    })

    it("truncates long feedback to 200 chars", () => {
      const records = [
        makeRecord({ feedback: "x".repeat(300) }),
      ]
      const formatted = formatRunHistoryForPrompt(records)
      // The feedback should be truncated
      const feedbackLine = formatted.split("\n").find((l) => l.startsWith("Feedback:"))
      expect(feedbackLine).toBeDefined()
      // 200 chars of x's + quotes + prefix
      expect(feedbackLine!.length).toBeLessThan(250)
    })
  })

  describe("findParentRunId", () => {
    it("returns undefined when no history exists", () => {
      expect(findParentRunId(tmpDir, 42)).toBeUndefined()
    })

    it("returns the last run's runId", () => {
      appendRunRecord(tmpDir, makeRecord({ runId: "run-1" }))
      appendRunRecord(tmpDir, makeRecord({ runId: "run-2" }))
      appendRunRecord(tmpDir, makeRecord({ runId: "run-3" }))

      expect(findParentRunId(tmpDir, 42)).toBe("run-3")
    })
  })
})
