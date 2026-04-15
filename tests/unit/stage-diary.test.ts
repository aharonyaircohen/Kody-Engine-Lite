import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-diary-test-"))
}

function tmpTaskDir(projectDir: string, taskId: string): string {
  const dir = path.join(projectDir, ".kody", "tasks", taskId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("stage-diary", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  // ─── extractReviewPatterns ─────────────────────────────────────────────────

  describe("extractReviewPatterns", () => {
    async function extractReviewPatterns(taskDir: string): Promise<string[]> {
      const { extractStagePatterns } = await import("../../src/stage-diary.js")
      return extractStagePatterns("review", taskDir)
    }

    it("returns verdict PASS when review.md contains pass", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-001")
      // The regex /verdict.*pass/i matches "verdict: PASS" (contains "pass" as substring)
      fs.writeFileSync(path.join(taskDir, "review.md"), "## Verdict\n\nverdict: PASS\n")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("verdict:PASS")
    })

    it("returns verdict FAIL when review.md contains fail", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-002")
      // The regex /verdict.*fail/i matches "verdict: FAIL"
      fs.writeFileSync(path.join(taskDir, "review.md"), "## Verdict\n\nverdict: FAIL\n")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("verdict:FAIL")
    })

    it("returns finding:security when review mentions security terms", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-003")
      fs.writeFileSync(path.join(taskDir, "review.md"), "## Security\n\nRoute was unprotected.\n")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("finding:security")
    })

    it("extracts route count from context.md", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-004")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "I investigated the 5 routes flagged by the security scanner.")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("investigation:5-routes-flagged")
    })

    it("extracts auth level from context.md", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-005")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "Wrapped GET handler with withApiHandler({ auth: 'public' })")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("auth:public")
    })

    it("extracts confirmed items already correct from context.md", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-006")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "Already correct — the POST handler was already protected with admin auth.")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("confirmed:existing-protection")
    })

    it("extracts finding:missing-auth from context.md", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-007")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "The GET handler was missing authentication.")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("finding:missing-auth")
    })

    it("extracts scope:api-route when API routes are mentioned", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-008")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "Investigating api/copilotkit/route.ts")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("scope:api-route")
    })

    it("extracts GET handler context from context.md", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-009")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "The GET handler on copilotkit was not wrapped with auth.")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("handler:GET")
    })

    it("extracts security scanner source from context.md", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-010")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "Security scanner flagged 5 routes missing authentication.")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("source:security-scanner")
    })

    it("returns empty array when no context.md or review.md exists", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-011")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toEqual([])
    })

    it("combines review findings and investigation facts", async () => {
      const taskDir = tmpTaskDir(projectDir, "test-012")
      fs.writeFileSync(path.join(taskDir, "review.md"),
        "## Verdict: PASS\n\nSecurity fix applied correctly.")
      fs.writeFileSync(path.join(taskDir, "context.md"),
        "Investigated 3 routes flagged by security scanner.")
      const patterns = await extractReviewPatterns(taskDir)
      expect(patterns).toContain("verdict:PASS")
      expect(patterns).toContain("finding:security")
      expect(patterns).toContain("investigation:3-routes-flagged")
    })
  })

  // ─── appendDiary / readDiary ──────────────────────────────────────────────

  describe("appendDiary / readDiary", () => {
    async function appendDiary(projectDir: string, entry: {
      taskId: string
      timestamp: string
      stage: string
      patterns: string[]
      room?: string
    }): Promise<void> {
      const { appendDiary: _append } = await import("../../src/stage-diary.js")
      _append(projectDir, entry)
    }

    async function readDiary(projectDir: string, stage: string, limit = 5) {
      const { readDiary: _read } = await import("../../src/stage-diary.js")
      return _read(projectDir, stage, limit)
    }

    it("appends and reads a diary entry", async () => {
      const entry = {
        taskId: "test-001",
        timestamp: "2026-04-14T00:00:00Z",
        stage: "review",
        patterns: ["verdict:PASS", "finding:security"],
      }
      await appendDiary(projectDir, entry)
      const entries = await readDiary(projectDir, "review")
      expect(entries).toHaveLength(1)
      expect(entries[0].patterns).toContain("verdict:PASS")
      expect(entries[0].patterns).toContain("finding:security")
    })

    it("readDiary returns empty array when file does not exist", async () => {
      const entries = await readDiary(projectDir, "nonexistent")
      expect(entries).toEqual([])
    })

    it("readDiary respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await appendDiary(projectDir, {
          taskId: `test-${i}`,
          timestamp: "2026-04-14T00:00:00Z",
          stage: "review",
          patterns: [`pattern:${i}`],
        })
      }
      const entries = await readDiary(projectDir, "review", 3)
      expect(entries).toHaveLength(3)
    })
  })

  // ─── formatDiaryForPrompt ─────────────────────────────────────────────────

  describe("formatDiaryForPrompt", () => {
    async function formatDiaryForPrompt(entries: {
      taskId: string
      timestamp: string
      stage: string
      patterns: string[]
      room?: string
    }[]): Promise<string> {
      const { formatDiaryForPrompt: _format } = await import("../../src/stage-diary.js")
      return _format(entries)
    }

    it("returns empty string for no entries", async () => {
      const result = await formatDiaryForPrompt([])
      expect(result).toBe("")
    })

    it("formats single entry as compressed line", async () => {
      const entries = [{
        taskId: "1234-260414",
        timestamp: "2026-04-14T15:00:00Z",
        stage: "review",
        patterns: ["verdict:PASS"],
      }]
      const result = await formatDiaryForPrompt(entries)
      expect(result).toContain("STAGE_DIARY|1entries")
      expect(result).toContain("verdict:PASS")
    })

    it("includes room tag when present", async () => {
      const entries = [{
        taskId: "1234-260414",
        timestamp: "2026-04-14T15:00:00Z",
        stage: "review",
        patterns: ["verdict:PASS"],
        room: "middleware",
      }]
      const result = await formatDiaryForPrompt(entries)
      expect(result).toContain("@middleware")
    })
  })
})
