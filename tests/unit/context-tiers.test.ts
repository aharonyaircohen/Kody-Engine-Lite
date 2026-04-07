import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  estimateTokens,
  truncateToTokens,
  generateL0,
  generateL1,
  getTieredContent,
  selectTier,
  resolveStagePolicy,
  readProjectMemoryTiered,
  injectTaskContextTiered,
} from "../../src/context-tiers.js"

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    expect(estimateTokens("")).toBe(0)
  })
})

describe("truncateToTokens", () => {
  it("returns content unchanged when under budget", () => {
    expect(truncateToTokens("short", 100)).toBe("short")
  })

  it("truncates when over budget", () => {
    const long = "x".repeat(500)
    const result = truncateToTokens(long, 50) // 50 tokens = 200 chars
    expect(result.length).toBeLessThan(300)
    expect(result).toContain("truncated")
  })
})

describe("generateL0", () => {
  it("extracts heading and first sentence from markdown", () => {
    const content = `# Architecture\n\nThis is a Next.js application. It uses TypeScript.\n\n## Details\nMore stuff here.`
    const result = generateL0(content, "architecture.md")
    expect(result).toContain("# Architecture")
    expect(result).toContain("This is a Next.js application.")
    expect(result).not.toContain("More stuff")
  })

  it("handles JSON files by extracting key fields", () => {
    const content = JSON.stringify({
      title: "Add retry logic",
      task_type: "feature",
      risk_level: "low",
    })
    const result = generateL0(content, "task.json")
    expect(result).toContain("Add retry logic")
    expect(result).toContain("feature")
    expect(result).toContain("low")
  })

  it("handles markdown-wrapped JSON", () => {
    const content = '```json\n{"title": "Fix bug", "task_type": "bugfix"}\n```'
    const result = generateL0(content, "task.json")
    expect(result).toContain("Fix bug")
  })

  it("returns empty for empty content", () => {
    expect(generateL0("", "file.md")).toBe("")
    expect(generateL0("   ", "file.md")).toBe("")
  })

  it("stays under 400 chars", () => {
    const content = `# Heading\n\n${"A very long sentence. ".repeat(50)}`
    const result = generateL0(content, "file.md")
    expect(result.length).toBeLessThanOrEqual(400)
  })
})

describe("generateL1", () => {
  it("extracts headings and first sentences", () => {
    const content = `# Architecture\n\nNext.js 14 app.\n\n## Stack\n- TypeScript\n- React\n- Prisma\n\n## Testing\nUses vitest.\n`
    const result = generateL1(content, "architecture.md")
    expect(result).toContain("# Architecture")
    expect(result).toContain("## Stack")
    expect(result).toContain("## Testing")
    expect(result).toContain("- TypeScript")
    expect(result).toContain("Uses vitest")
  })

  it("limits bullet items to 5 per section", () => {
    const bullets = Array.from({ length: 10 }, (_, i) => `- Item ${i}`).join("\n")
    const content = `# Section\n${bullets}`
    const result = generateL1(content, "file.md")
    expect(result).toContain("- Item 0")
    expect(result).toContain("- Item 4")
    expect(result).not.toContain("- Item 5")
  })

  it("handles JSON files", () => {
    const content = JSON.stringify({
      title: "Add feature",
      task_type: "feature",
      risk_level: "medium",
      scope: ["src/a.ts", "src/b.ts"],
    })
    const result = generateL1(content, "task.json")
    expect(result).toContain("title: Add feature")
    expect(result).toContain("scope: [2 items]")
  })

  it("stays under 1600 chars", () => {
    const sections = Array.from({ length: 20 }, (_, i) => `## Section ${i}\n${"Content. ".repeat(20)}`).join("\n\n")
    const result = generateL1(sections, "file.md")
    expect(result.length).toBeLessThanOrEqual(1600)
  })

  it("returns empty for empty content", () => {
    expect(generateL1("", "file.md")).toBe("")
  })
})

describe("getTieredContent", () => {
  it("generates tiered content", () => {
    const content = "# Test\n\nThis is test content. It has details.\n\n## Section\n- Item 1\n- Item 2\n"
    const result = getTieredContent("/tmp/test.md", content)

    expect(result.L0).toBeTruthy()
    expect(result.L1).toBeTruthy()
    expect(result.L2).toBe(content)
  })

  it("returns consistent results for same input", () => {
    const content = "# Test\n\nContent here.\n"
    const first = getTieredContent("/tmp/test.md", content)
    const second = getTieredContent("/tmp/test.md", content)

    expect(second).toEqual(first)
  })
})

describe("selectTier", () => {
  it("returns correct tier content", () => {
    const tiered = { source: "f", L0: "abstract", L1: "overview", L2: "full" }
    expect(selectTier(tiered, "L0")).toBe("abstract")
    expect(selectTier(tiered, "L1")).toBe("overview")
    expect(selectTier(tiered, "L2")).toBe("full")
  })
})

describe("resolveStagePolicy", () => {
  it("returns default policy for known stage", () => {
    const policy = resolveStagePolicy("build")
    expect(policy.plan).toBe("L2")
    expect(policy.memory).toBe("L1")
  })

  it("falls back to build policy for unknown stage", () => {
    const policy = resolveStagePolicy("unknown-stage")
    expect(policy.plan).toBe("L2")
  })

  it("applies overrides", () => {
    const policy = resolveStagePolicy("build", { build: { memory: "L2" } })
    expect(policy.memory).toBe("L2")
    expect(policy.plan).toBe("L2") // unchanged default
  })
})

describe("readProjectMemoryTiered", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-tiered-mem-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty for missing directory", () => {
    expect(readProjectMemoryTiered(path.join(tmpDir, "nonexistent"), "L1")).toBe("")
  })

  it("returns L1 overview of memory files", () => {
    const memDir = path.join(tmpDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "architecture.md"), "# Arch\n\nNext.js app with TypeScript.\n\n## Stack\n- React\n- Prisma\n")
    fs.writeFileSync(path.join(memDir, "conventions.md"), "# Conventions\n\nUses vitest for testing.\n")

    const result = readProjectMemoryTiered(tmpDir, "L1")
    expect(result).toContain("overview")
    expect(result).toContain("## architecture")
    expect(result).toContain("## conventions")
  })

  it("returns full content at L2", () => {
    const memDir = path.join(tmpDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "arch.md"), "# Full Content\n\nAll details here.\n")

    const result = readProjectMemoryTiered(tmpDir, "L2")
    expect(result).toContain("All details here.")
    expect(result).not.toContain("overview")
  })

  it("returns compact format at L0", () => {
    const memDir = path.join(tmpDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "arch.md"), "# Architecture\n\nBig application with many features.\n\n## Details\n- Feature 1\n- Feature 2\n")

    const result = readProjectMemoryTiered(tmpDir, "L0")
    expect(result).toContain("Memory(compact)")
  })
})

describe("injectTaskContextTiered", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-tiered-ctx-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("uses L2 for task description when policy says so", () => {
    fs.writeFileSync(path.join(tmpDir, "task.md"), "Add a sum function with error handling")
    const policy = resolveStagePolicy("taskify")
    const result = injectTaskContextTiered("{{TASK_CONTEXT}}", "t1", tmpDir, policy)
    expect(result).toContain("Add a sum function with error handling")
    expect(result).not.toContain("{{TASK_CONTEXT}}")
  })

  it("uses L0 for plan when policy says so", () => {
    fs.writeFileSync(path.join(tmpDir, "plan.md"), "# Implementation Plan\n\nStep 1: Create the module.\n\n## Steps\n- File: src/sum.ts\n- File: tests/sum.test.ts\n\n## Details\nLong detailed description here.\n")
    const policy = resolveStagePolicy("taskify") // plan=L0
    const result = injectTaskContextTiered("{{TASK_CONTEXT}}", "t1", tmpDir, policy)
    expect(result).toContain("abstract")
    expect(result).toContain("# Implementation Plan")
    expect(result).not.toContain("Long detailed description")
  })

  it("uses L2 for plan in build stage", () => {
    const fullPlan = "# Plan\n\nStep 1: Create module.\n\n## Full Details\nLong detailed description that should be included.\n"
    fs.writeFileSync(path.join(tmpDir, "plan.md"), fullPlan)
    const policy = resolveStagePolicy("build") // plan=L2
    const result = injectTaskContextTiered("{{TASK_CONTEXT}}", "t1", tmpDir, policy)
    expect(result).toContain("Long detailed description that should be included.")
  })

  it("always includes feedback at full length", () => {
    const policy = resolveStagePolicy("autofix")
    const result = injectTaskContextTiered("{{TASK_CONTEXT}}", "t1", tmpDir, policy, "Fix the edge case in retry logic")
    expect(result).toContain("Human Feedback")
    expect(result).toContain("Fix the edge case in retry logic")
  })

  it("handles task.json classification at L2", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({ task_type: "feature", title: "Test", risk_level: "low" }))
    const policy = resolveStagePolicy("plan") // taskClassification=L2
    const result = injectTaskContextTiered("{{TASK_CONTEXT}}", "t1", tmpDir, policy)
    expect(result).toContain("Type: feature")
    expect(result).toContain("Risk: low")
  })

  it("handles task.json classification at L0", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({ title: "Test", task_type: "feature", risk_level: "low" }))
    const policy = resolveStagePolicy("taskify") // taskClassification=L0
    const result = injectTaskContextTiered("{{TASK_CONTEXT}}", "t1", tmpDir, policy)
    expect(result).toContain("abstract")
    expect(result).toContain("Title: Test")
  })

  it("handles missing artifacts gracefully", () => {
    const policy = resolveStagePolicy("build")
    const result = injectTaskContextTiered("{{TASK_CONTEXT}}", "t1", tmpDir, policy)
    expect(result).toContain("t1")
    expect(result).not.toContain("{{TASK_CONTEXT}}")
  })
})
