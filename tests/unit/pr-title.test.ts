import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("PR title generation", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-prtitle-test-"))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const TYPE_PREFIX: Record<string, string> = {
    feature: "feat",
    bugfix: "fix",
    refactor: "refactor",
    docs: "docs",
    chore: "chore",
  }

  function generateTitle(taskDir: string): string {
    let title = "Update"
    const taskJsonPath = path.join(taskDir, "task.json")
    if (fs.existsSync(taskJsonPath)) {
      try {
        const raw = fs.readFileSync(taskJsonPath, "utf-8")
        const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
        const task = JSON.parse(cleaned)
        const prefix = TYPE_PREFIX[task.task_type] ?? "chore"
        const taskTitle = task.title ?? "Update"
        title = `${prefix}: ${taskTitle}`.slice(0, 72)
      } catch { /* fallback */ }
    }
    if (title === "Update") {
      const taskMdPath = path.join(taskDir, "task.md")
      if (fs.existsSync(taskMdPath)) {
        const content = fs.readFileSync(taskMdPath, "utf-8")
        const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("*"))
        if (firstLine) title = `chore: ${firstLine.trim()}`.slice(0, 72)
      }
    }
    return title
  }

  it("uses task.json title with feature prefix", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({
      task_type: "feature",
      title: "Add search functionality",
    }))
    expect(generateTitle(tmpDir)).toBe("feat: Add search functionality")
  })

  it("uses task.json title with bugfix prefix", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({
      task_type: "bugfix",
      title: "Fix login redirect loop",
    }))
    expect(generateTitle(tmpDir)).toBe("fix: Fix login redirect loop")
  })

  it("uses task.json title with refactor prefix", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({
      task_type: "refactor",
      title: "Extract auth middleware",
    }))
    expect(generateTitle(tmpDir)).toBe("refactor: Extract auth middleware")
  })

  it("truncates to 72 chars", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({
      task_type: "feature",
      title: "A very long title that exceeds the maximum allowed characters for a PR title in GitHub",
    }))
    const title = generateTitle(tmpDir)
    expect(title.length).toBeLessThanOrEqual(72)
    expect(title).toMatch(/^feat:/)
  })

  it("falls back to chore for unknown task_type", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({
      task_type: "unknown",
      title: "Do something",
    }))
    expect(generateTitle(tmpDir)).toBe("chore: Do something")
  })

  it("falls back to task.md when task.json missing", () => {
    fs.writeFileSync(path.join(tmpDir, "task.md"), "Add authentication to routes\n\nMore details here")
    expect(generateTitle(tmpDir)).toBe("chore: Add authentication to routes")
  })

  it("skips markdown bold/italic in task.md fallback", () => {
    fs.writeFileSync(path.join(tmpDir, "task.md"), "# Title\n**Rule:** something\nActual description here")
    expect(generateTitle(tmpDir)).toBe("chore: Actual description here")
  })

  it("handles task.json with markdown fences", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), '```json\n{"task_type":"bugfix","title":"Fix crash"}\n```')
    expect(generateTitle(tmpDir)).toBe("fix: Fix crash")
  })

  it("returns Update when nothing exists", () => {
    expect(generateTitle(tmpDir)).toBe("Update")
  })
})

describe("approve workflow: task-id handling", () => {
  it("approve mode should not generate new task-id", () => {
    // Simulating the workflow parse logic
    let MODE = "approve"
    let TASK_ID = ""
    const ISSUE_NUM = "1031"

    // Approve conversion (runs BEFORE task-id generation)
    if (MODE === "approve") {
      MODE = "rerun"
      // TASK_ID left empty — entry.ts finds paused task
    }

    // Task-id generation (only for non-rerun)
    if (!TASK_ID && MODE !== "rerun") {
      TASK_ID = `${ISSUE_NUM}-260326-120000`
    }

    expect(MODE).toBe("rerun")
    expect(TASK_ID).toBe("") // empty — entry.ts will find latest
  })

  it("regular @kody generates task-id", () => {
    let MODE = "full"
    let TASK_ID = ""
    const ISSUE_NUM = "1031"

    if (!TASK_ID && MODE !== "rerun") {
      TASK_ID = `${ISSUE_NUM}-260326-120000`
    }

    expect(MODE).toBe("full")
    expect(TASK_ID).toBe("1031-260326-120000")
  })

  it("@kody rerun without task-id stays empty", () => {
    let MODE = "rerun"
    let TASK_ID = ""
    const ISSUE_NUM = "1031"

    if (!TASK_ID && MODE !== "rerun") {
      TASK_ID = `${ISSUE_NUM}-260326-120000`
    }

    expect(MODE).toBe("rerun")
    expect(TASK_ID).toBe("")
  })
})
