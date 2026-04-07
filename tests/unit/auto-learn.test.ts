import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { autoLearn } from "../../src/learning/auto-learn.js"
import type { PipelineContext } from "../../src/types.js"

function makeTmpDirs() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-autolearn-"))
  const taskDir = path.join(projectDir, ".kody", "tasks", "test-task")
  fs.mkdirSync(taskDir, { recursive: true })
  return { projectDir, taskDir }
}

function makeCtx(projectDir: string, taskDir: string): PipelineContext {
  return {
    taskId: "test-task",
    taskDir,
    projectDir,
    runners: {},
    input: { mode: "full" },
  } as PipelineContext
}

describe("autoLearn", () => {
  let projectDir: string
  let taskDir: string

  beforeEach(() => {
    const dirs = makeTmpDirs()
    projectDir = dirs.projectDir
    taskDir = dirs.taskDir
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("extracts conventions from verify.md", () => {
    fs.writeFileSync(path.join(taskDir, "verify.md"), "Running vitest...\neslint found 0 errors\ntsc --noEmit passed")
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const conventions = fs.readFileSync(path.join(projectDir, ".kody", "memory", "conventions.md"), "utf-8")
    expect(conventions).toContain("Uses vitest for testing")
    expect(conventions).toContain("Uses eslint for linting")
    expect(conventions).toContain("Uses TypeScript (tsc)")
  })

  it("extracts conventions from review.md", () => {
    fs.writeFileSync(path.join(taskDir, "review.md"), "Imports should use .js extension for ESM compatibility.\nConsider barrel export patterns.")
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const conventions = fs.readFileSync(path.join(projectDir, ".kody", "memory", "conventions.md"), "utf-8")
    expect(conventions).toContain("Imports use .js extensions (ESM)")
    expect(conventions).toContain("Uses barrel exports")
  })

  it("extracts active directories from task.json", () => {
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      task_type: "feature",
      title: "Add auth",
      scope: ["src/auth/login.ts", "src/auth/middleware.ts", "src/utils/token.ts"],
      risk_level: "medium",
    }))
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const conventions = fs.readFileSync(path.join(projectDir, ".kody", "memory", "conventions.md"), "utf-8")
    expect(conventions).toContain("Active directories:")
    expect(conventions).toContain("src/auth")
  })

  it("strips ANSI codes from verify.md", () => {
    fs.writeFileSync(path.join(taskDir, "verify.md"), "\x1b[32mvitest\x1b[0m passed")
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const conventions = fs.readFileSync(path.join(projectDir, ".kody", "memory", "conventions.md"), "utf-8")
    expect(conventions).toContain("Uses vitest for testing")
  })

  it("auto-detects architecture when architecture.md missing", () => {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
      dependencies: { next: "14.0.0" },
      devDependencies: { typescript: "5.0.0", vitest: "1.0.0" },
    }))
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const archPath = path.join(projectDir, ".kody", "memory", "facts_architecture.md")
    expect(fs.existsSync(archPath)).toBe(true)
    const arch = fs.readFileSync(archPath, "utf-8")
    expect(arch).toContain("Next.js")
    expect(arch).toContain("TypeScript")
  })

  it("does not overwrite existing architecture.md", () => {
    const memoryDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memoryDir, { recursive: true })
    fs.writeFileSync(path.join(memoryDir, "architecture.md"), "# Custom Architecture\n\nHand-written.")
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
      dependencies: { express: "4.0.0" },
    }))
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const arch = fs.readFileSync(path.join(memoryDir, "architecture.md"), "utf-8")
    expect(arch).toContain("Hand-written")
    expect(arch).not.toContain("Express")
  })

  it("handles missing artifact files gracefully", () => {
    const ctx = makeCtx(projectDir, taskDir)

    // Should not throw
    expect(() => autoLearn(ctx)).not.toThrow()
  })

  it("does not write conventions.md when no learnings found", () => {
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const conventionsPath = path.join(projectDir, ".kody", "memory", "conventions.md")
    expect(fs.existsSync(conventionsPath)).toBe(false)
  })

  it("handles markdown-wrapped task.json", () => {
    fs.writeFileSync(path.join(taskDir, "task.json"), '```json\n{"task_type":"feature","title":"Test","scope":["src/foo/bar.ts"],"risk_level":"low"}\n```')
    const ctx = makeCtx(projectDir, taskDir)

    autoLearn(ctx)

    const conventions = fs.readFileSync(path.join(projectDir, ".kody", "memory", "conventions.md"), "utf-8")
    expect(conventions).toContain("src/foo")
  })
})
