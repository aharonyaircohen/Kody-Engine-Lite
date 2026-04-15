import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  readDiary,
  appendDiary,
  formatDiaryForPrompt,
  extractStagePatterns,
  extractBuildPatterns,
} from "../../src/stage-diary.js"
import type { DiaryEntry } from "../../src/stage-diary.js"

function taskDir(tmpDir: string, name = "task-123"): string {
  return path.join(tmpDir, ".kody", "tasks", name)
}

function makeEntry(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    taskId: "42-260415-120000",
    timestamp: "2026-04-15T12:00:00.000Z",
    stage: "review",
    patterns: ["verdict:PASS", "domain:security"],
    room: "scanner",
    ...overrides,
  }
}

describe("stage-diary storage", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diary-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("appendDiary / readDiary", () => {
    it("creates directory and writes entry", () => {
      const entry = makeEntry({ stage: "review" })
      appendDiary(tmpDir, entry)

      const entries = readDiary(tmpDir, "review")
      expect(entries).toHaveLength(1)
      expect(entries[0].patterns).toEqual(["verdict:PASS", "domain:security"])
    })

    it("reads only the requested stage", () => {
      appendDiary(tmpDir, makeEntry({ stage: "review" }))
      appendDiary(tmpDir, makeEntry({ stage: "verify", patterns: ["tsc:clean"] }))

      expect(readDiary(tmpDir, "review")).toHaveLength(1)
      expect(readDiary(tmpDir, "verify")).toHaveLength(1)
    })

    it("returns empty array for missing diary", () => {
      expect(readDiary(tmpDir, "nonexistent")).toEqual([])
    })

    it("prunes to last 30 entries", () => {
      for (let i = 0; i < 35; i++) {
        appendDiary(tmpDir, makeEntry({ taskId: `run-${i}`, patterns: [`p${i}`] }))
      }
      // readDiary defaults to limit=5; pass explicit limit to read all
      const entries = readDiary(tmpDir, "review", 50)
      expect(entries).toHaveLength(30)
      expect(entries[0].taskId).toBe("run-5")
      expect(entries[29].taskId).toBe("run-34")
    })

    it("skips malformed lines", () => {
      const diaryPath = path.join(tmpDir, ".kody", "memory", "diary_review.jsonl")
      fs.mkdirSync(path.dirname(diaryPath), { recursive: true })
      fs.appendFileSync(diaryPath, "not valid json\n")
      fs.appendFileSync(diaryPath, JSON.stringify(makeEntry()) + "\n")

      const entries = readDiary(tmpDir, "review")
      expect(entries).toHaveLength(1)
    })
  })

  describe("formatDiaryForPrompt", () => {
    it("returns empty string for no entries", () => {
      expect(formatDiaryForPrompt([])).toBe("")
    })

    it("formats entry with date, taskId, room, and patterns", () => {
      const entry: DiaryEntry = {
        taskId: "42-260415-120000-abcdef",
        timestamp: "2026-04-15T12:00:00.000Z",
        stage: "review",
        patterns: ["verdict:PASS", "domain:security", "files:scripts/inspector/..."],
        room: "scanner",
      }
      const result = formatDiaryForPrompt([entry])
      expect(result).toContain("STAGE_DIARY|1entries")
      expect(result).toContain("2026-04-15:42-260415-12")
      expect(result).toContain("@scanner")
      expect(result).toContain("verdict:PASS|domain:security|files:scripts/inspector/...")
    })

    it("handles entry without room", () => {
      const entry: DiaryEntry = {
        taskId: "99-260415-130000",
        timestamp: "2026-04-15T13:00:00.000Z",
        stage: "build",
        patterns: ["files.created:foo.ts,bar.ts"],
      }
      const result = formatDiaryForPrompt([entry])
      expect(result).toContain("2026-04-15:99-260415-13")
      expect(result).not.toContain("@")
    })
  })
})

describe("extractStagePatterns", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-extract-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("review stage — extractReviewPatterns", () => {
    it("extracts verdict PASS from review.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "## Review\n\nverdict: PASS\n\nAll checks passed.")
      fs.writeFileSync(path.join(td, "task.md"), "Fix security scanner regex")
      fs.writeFileSync(path.join(td, "context.md"), "scripts/inspector/plugins/project/security-scanner/rules.ts")
      fs.writeFileSync(path.join(td, "plan.md"), "Fix the regex pattern")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toContain("verdict:PASS")
    })

    it("extracts verdict FAIL from review.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: FAIL\n\nSome issues remain.")
      fs.writeFileSync(path.join(td, "task.md"), "Fix bug in auth")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toContain("verdict:FAIL")
    })

    it("extracts domain:security from task.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Security: scanner regex matches false positives for withApiHandler<T>")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toContain("domain:security")
    })

    it("extracts domain:bugfix from task.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Bug: form validation crashes on empty string")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toContain("domain:bugfix")
    })

    it("extracts domain:feature from task.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Add new dark mode toggle to settings")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toContain("domain:feature")
    })

    it("extracts domain:refactor from task.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Restructure payment middleware to use a cleaner pattern")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toContain("domain:refactor")
    })

    it("extracts domain:docs from task.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Improve documentation in the README")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toContain("domain:docs")
    })

    it("extracts file scope from context.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Fix security issue")
      fs.writeFileSync(
        path.join(td, "context.md"),
        "scripts/inspector/plugins/project/security-scanner/rules.ts\nsrc/auth/middleware.ts",
      )

      const patterns = extractStagePatterns("review", td)
      const scopePattern = patterns.find((p) => p.startsWith("files:"))
      expect(scopePattern).toBeDefined()
      expect(scopePattern).toContain("scripts/inspector")
      expect(scopePattern).toContain("auth")
    })

    it("extracts fix descriptor from plan.md diff line", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Fix regex")
      fs.writeFileSync(
        path.join(td, "plan.md"),
        "## Plan\n- Update the regex pattern:\n- /withApiHandler\\s*\\(/,\n+ /withApiHandler(?:\\s*<[^>]+>)?\\s*\\(/",
      )

      const patterns = extractStagePatterns("review", td)
      const fixPattern = patterns.find((p) => p.startsWith("fix:"))
      expect(fixPattern).toBeDefined()
      expect(fixPattern).toContain("withApiHandler")
    })

    it("extracts fix descriptor from plan.md description fallback", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")
      fs.writeFileSync(path.join(td, "task.md"), "Fix bug")
      fs.writeFileSync(path.join(td, "plan.md"), "## Plan\n\nUpdate the regex pattern to handle TypeScript generics")

      const patterns = extractStagePatterns("review", td)
      const fixPattern = patterns.find((p) => p.startsWith("fix:"))
      expect(fixPattern).toBeDefined()
      expect(fixPattern).toContain("regex pattern")
    })

    it("returns only verdict when only review.md exists", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "review.md"), "verdict: PASS")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toEqual(["verdict:PASS"])
    })

    it("does NOT false-positive on generic keywords in review.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      // Old buggy behavior: these would trigger finding:type-safety and finding:test-coverage
      // from reviewing text that mentions "test coverage" in passing
      fs.writeFileSync(
        path.join(td, "review.md"),
        "Reviewed the test coverage report. Type assertions are used in a few places but are acceptable.",
      )
      fs.writeFileSync(path.join(td, "task.md"), "Fix security scanner regex")

      const patterns = extractStagePatterns("review", td)
      expect(patterns).not.toContain("finding:type-safety")
      expect(patterns).not.toContain("finding:test-coverage")
      expect(patterns).toContain("domain:security")
    })

    it("returns empty array when no review files exist", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })

      const patterns = extractStagePatterns("review", td)
      expect(patterns).toEqual([])
    })
  })

  describe("verify stage — extractVerifyPatterns", () => {
    it("extracts test pass/fail counts", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "verify.md"), "15 tests passed, 0 tests failed")

      const patterns = extractStagePatterns("verify", td)
      expect(patterns).toContain("tests:15pass.0fail")
    })

    it("extracts pre-existing failure file", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "verify.md"), "pre-existing failure in auth.test.ts")

      const patterns = extractStagePatterns("verify", td)
      expect(patterns).toContain("preexisting.fail:auth.test.ts")
    })

    it("extracts tsc errors", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "verify.md"), "tsc found 3 errors")

      const patterns = extractStagePatterns("verify", td)
      expect(patterns).toContain("tsc:errors.found")
    })

    it("extracts tsc clean", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "verify.md"), "tsc: no errors found")

      const patterns = extractStagePatterns("verify", td)
      expect(patterns).toContain("tsc:clean")
    })

    it("extracts lint errors and clean lint", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "verify.md"), "eslint found 2 errors\nlint: 0 errors")

      const patterns = extractStagePatterns("verify", td)
      expect(patterns).toContain("lint:errors.found")
      expect(patterns).toContain("lint:clean")
    })

    it("returns empty array when no verify.md exists", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })

      const patterns = extractStagePatterns("verify", td)
      expect(patterns).toEqual([])
    })
  })

  describe("build stage — extractBuildPatterns", () => {
    it("extracts created files from context.md", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(
        path.join(td, "context.md"),
        "Created src/utils/helper.ts\nwrote tests/unit/helper.test.ts",
      )

      const patterns = extractBuildPatterns(td)
      expect(patterns).toContain("files.created:src/utils/helper.ts,tests/unit/helper.test.ts")
    })

    it("extracts import pattern: path alias", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "context.md"), "import { foo } from '@/utils/bar'")

      const patterns = extractBuildPatterns(td)
      expect(patterns).toContain("imports:path-alias(@/)")
    })

    it("extracts import pattern: relative paths", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      fs.writeFileSync(path.join(td, "context.md"), "import { foo } from './utils/bar'")

      const patterns = extractBuildPatterns(td)
      expect(patterns).toContain("imports:relative-paths")
    })

    it("returns empty array when no context.md exists", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })

      const patterns = extractBuildPatterns(td)
      expect(patterns).toEqual([])
    })
  })

  describe("unknown stage", () => {
    it("returns empty array", () => {
      const td = taskDir(tmpDir)
      fs.mkdirSync(td, { recursive: true })
      expect(extractStagePatterns("ship", td)).toEqual([])
    })
  })
})
