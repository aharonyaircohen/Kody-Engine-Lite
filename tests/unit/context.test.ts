import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { injectTaskContext, resolveModel, buildFullPrompt, inferHasUIFromScope, taskHasUI } from "../../src/context.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import { readProjectMemory } from "../../src/memory.js"

describe("injectTaskContext", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-context-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("replaces {{TASK_CONTEXT}} with task info", () => {
    fs.writeFileSync(path.join(tmpDir, "task.md"), "Add a sum function")
    const result = injectTaskContext("Prompt: {{TASK_CONTEXT}}", "test-1", tmpDir)
    expect(result).toContain("Add a sum function")
    expect(result).toContain("test-1")
    expect(result).not.toContain("{{TASK_CONTEXT}}")
  })

  it("handles missing artifacts gracefully", () => {
    const result = injectTaskContext("Prompt: {{TASK_CONTEXT}}", "test-2", tmpDir)
    expect(result).toContain("test-2")
    expect(result).not.toContain("{{TASK_CONTEXT}}")
  })

  it("includes task.json classification", () => {
    fs.writeFileSync(
      path.join(tmpDir, "task.json"),
      JSON.stringify({ task_type: "feature", title: "Test", risk_level: "low" }),
    )
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-3", tmpDir)
    expect(result).toContain("feature")
    expect(result).toContain("low")
  })

  it("includes plan.md content", () => {
    fs.writeFileSync(path.join(tmpDir, "plan.md"), "Step 1: Do the thing\nStep 2: Verify")
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-4", tmpDir)
    expect(result).toContain("Step 1: Do the thing")
  })

  it("includes feedback when provided", () => {
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-5", tmpDir, "Fix the edge case")
    expect(result).toContain("Human Feedback")
    expect(result).toContain("Fix the edge case")
  })

  it("excludes feedback section when not provided", () => {
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-6", tmpDir)
    expect(result).not.toContain("Human Feedback")
  })

  it("includes accumulated context from context.md", () => {
    fs.writeFileSync(path.join(tmpDir, "context.md"), "### taskify (2026-03-27)\nClassified as LOW risk, scope: src/utils/retry.ts\n")
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-ctx", tmpDir)
    expect(result).toContain("Previous Stage Context")
    expect(result).toContain("Classified as LOW risk")
  })

  it("excludes accumulated context when context.md missing", () => {
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-ctx", tmpDir)
    expect(result).not.toContain("Previous Stage Context")
  })

  it("truncates very large accumulated context", () => {
    const longContext = "x".repeat(500000)
    fs.writeFileSync(path.join(tmpDir, "context.md"), longContext)
    const result = injectTaskContext("{{TASK_CONTEXT}}", "test-ctx", tmpDir)
    expect(result).toContain("(earlier context truncated)")
    expect(result.length).toBeLessThan(500000)
  })
})

describe("resolveModel", () => {
  beforeEach(() => resetProjectConfig())
  afterEach(() => resetProjectConfig())

  it("maps tier to configured model name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-defaults-"))
    fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify({
      agent: { modelMap: { cheap: "test-model-cheap", mid: "test-model-mid", strong: "test-model-strong" } }
    }))
    setConfigDir(dir)
    expect(resolveModel("cheap")).toBe("test-model-cheap")
    expect(resolveModel("mid")).toBe("test-model-mid")
    expect(resolveModel("strong")).toBe("test-model-strong")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("throws for unknown tier with no config fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-defaults-"))
    fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify({
      agent: { modelMap: { cheap: "test-cheap" } }
    }))
    setConfigDir(dir)
    expect(() => resolveModel("unknown")).toThrow("No model configured for tier")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("uses config modelMap when available", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-model-test-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({ agent: { modelMap: { cheap: "custom-cheap", mid: "custom-mid", strong: "custom-strong" } } }),
    )
    setConfigDir(tmpDir)
    expect(resolveModel("cheap")).toBe("custom-cheap")
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

})

describe("inferHasUIFromScope", () => {
  it("returns true for frontend extensions", () => {
    expect(inferHasUIFromScope(["src/components/Button.tsx"])).toBe(true)
    expect(inferHasUIFromScope(["app/page.jsx"])).toBe(true)
    expect(inferHasUIFromScope(["src/App.vue"])).toBe(true)
    expect(inferHasUIFromScope(["src/App.svelte"])).toBe(true)
    expect(inferHasUIFromScope(["styles/main.css"])).toBe(true)
    expect(inferHasUIFromScope(["styles/theme.scss"])).toBe(true)
    expect(inferHasUIFromScope(["styles/vars.sass"])).toBe(true)
    expect(inferHasUIFromScope(["styles/utils.less"])).toBe(true)
    expect(inferHasUIFromScope(["public/index.html"])).toBe(true)
  })

  it("returns true for UI directory paths", () => {
    expect(inferHasUIFromScope(["src/components/Header.ts"])).toBe(true)
    expect(inferHasUIFromScope(["src/pages/index.ts"])).toBe(true)
    expect(inferHasUIFromScope(["src/layouts/Default.ts"])).toBe(true)
    expect(inferHasUIFromScope(["src/styles/theme.ts"])).toBe(true)
    expect(inferHasUIFromScope(["src/views/Dashboard.ts"])).toBe(true)
  })

  it("returns false for backend-only scope", () => {
    expect(inferHasUIFromScope(["src/api/users.ts"])).toBe(false)
    expect(inferHasUIFromScope(["src/utils/retry.ts"])).toBe(false)
    expect(inferHasUIFromScope(["prisma/schema.prisma"])).toBe(false)
    expect(inferHasUIFromScope(["src/services/auth.ts", "src/lib/db.ts"])).toBe(false)
  })

  it("returns true if any file in scope is frontend", () => {
    expect(inferHasUIFromScope(["src/api/users.ts", "src/components/UserList.tsx"])).toBe(true)
  })

  it("returns false for empty scope", () => {
    expect(inferHasUIFromScope([])).toBe(false)
  })

  it("is case-insensitive for extensions", () => {
    expect(inferHasUIFromScope(["src/App.TSX"])).toBe(true)
    expect(inferHasUIFromScope(["styles/main.CSS"])).toBe(true)
  })
})

describe("taskHasUI", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-hasui-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns true when task.json does not exist", () => {
    expect(taskHasUI(tmpDir)).toBe(true)
  })

  it("returns true when scope is empty", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({ scope: [] }))
    expect(taskHasUI(tmpDir)).toBe(true)
  })

  it("returns true when scope is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({ title: "test" }))
    expect(taskHasUI(tmpDir)).toBe(true)
  })

  it("returns true when scope contains frontend files", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({ scope: ["src/components/Button.tsx"] }))
    expect(taskHasUI(tmpDir)).toBe(true)
  })

  it("returns false when scope contains only backend files", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), JSON.stringify({ scope: ["src/api/users.ts", "src/lib/db.ts"] }))
    expect(taskHasUI(tmpDir)).toBe(false)
  })

  it("returns true when task.json is invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "task.json"), "not json")
    expect(taskHasUI(tmpDir)).toBe(true)
  })
})

describe("buildFullPrompt with tiered context", () => {
  let projectDir: string
  let taskDir: string

  beforeEach(() => {
    resetProjectConfig()
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-tiered-prompt-"))
    taskDir = path.join(projectDir, ".kody", "tasks", "test-task")
    fs.mkdirSync(taskDir, { recursive: true })

    // Create memory
    const memDir = path.join(projectDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "architecture.md"), "# Architecture\n\nNext.js 14 application with TypeScript, React, and Prisma ORM. The application follows a modular architecture with clear separation of concerns between the presentation layer, business logic, and data access layer.\n\n## Stack\n- Framework: Next.js 14 with App Router\n- Language: TypeScript 5.3 with strict mode enabled\n- ORM: Prisma with PostgreSQL database\n- Testing: vitest for unit tests, playwright for e2e\n- Linting: eslint with custom rules for the project\n- Formatting: prettier with 2-space indentation\n- State Management: zustand for client state, react-query for server state\n- Authentication: next-auth with custom providers\n\n## Directory Structure\n- src/app/ - Next.js app router pages and layouts\n- src/components/ - Reusable React components organized by feature\n- src/components/ui/ - Base UI primitives (Button, Input, Modal)\n- src/lib/ - Shared utilities and helper functions\n- src/lib/api/ - API client and request helpers\n- src/lib/hooks/ - Custom React hooks\n- src/services/ - Business logic services\n- src/types/ - TypeScript type definitions\n- prisma/ - Database schema and migrations\n- tests/ - Test files organized by type (unit, integration, e2e)\n\n## API Design\nAll API routes follow REST conventions with JSON responses. Error responses use a standard envelope format with status code, message, and optional details. Rate limiting is applied to all public endpoints.\n\n## Database\nPrisma schema uses soft deletes for all entities. Migrations are applied automatically in CI/CD. The database uses row-level security for multi-tenant isolation.\n")
    fs.writeFileSync(path.join(memDir, "conventions.md"), "# Conventions\n\nAll imports use .js extensions for ESM compatibility. This is enforced by eslint and the TypeScript compiler configuration.\n\n## Testing\n- Uses vitest for unit tests with jsdom environment\n- Test files co-located with source in __tests__ directories\n- 80% coverage target enforced in CI\n- Integration tests use test database with automatic cleanup\n- E2E tests run against staging environment\n- Mock external APIs using msw (Mock Service Worker)\n- Use factory functions for test data generation\n\n## Code Style\n- Strict TypeScript with no implicit any\n- No any types allowed — use unknown with type guards\n- Prefer const assertions for literal types\n- Use barrel exports from feature directories\n- Maximum file length: 400 lines\n- Functions should be under 50 lines\n- Use early returns to reduce nesting\n\n## Git Workflow\n- Feature branches from main\n- Squash merge to main\n- Conventional commits required\n- PR reviews required from at least one team member\n- CI must pass before merge\n\n## Error Handling\n- Use custom error classes extending AppError\n- Log errors with structured metadata\n- Never expose internal errors to clients\n- Use error boundaries in React components\n")

    // Create task artifacts
    fs.writeFileSync(path.join(taskDir, "task.md"), "Add a retry utility function with exponential backoff support")
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({ title: "Add retry utility", task_type: "feature", risk_level: "low", scope: ["src/lib/retry.ts"] }))
    fs.writeFileSync(path.join(taskDir, "plan.md"), "# Implementation Plan\n\nStep 1: Create retry utility.\n\n## Steps\n1. Create src/lib/retry.ts with exponential backoff\n2. Create tests/lib/retry.test.ts\n3. Export from src/lib/index.ts\n\n## Detailed Design\nThe retry function accepts a function and options (maxRetries, baseDelay, maxDelay). It uses exponential backoff with jitter.\n")

    // Create prompt template
    const stepsDir = path.join(projectDir, ".kody", "steps")
    fs.mkdirSync(stepsDir, { recursive: true })
    fs.writeFileSync(path.join(stepsDir, "build.md"), "You are a code builder.\n\n{{TASK_CONTEXT}}")
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    resetProjectConfig()
  })

  it("produces identical output when tiers disabled vs explicit false", () => {
    // Explicitly disabled
    fs.writeFileSync(path.join(projectDir, "kody.config.json"), JSON.stringify({ agent: {}, contextTiers: { enabled: false } }))
    setConfigDir(projectDir)
    const first = buildFullPrompt("build", "test-task", taskDir, projectDir)

    resetProjectConfig()

    // Also explicitly disabled with different syntax
    fs.writeFileSync(path.join(projectDir, "kody.config.json"), JSON.stringify({ agent: {}, contextTiers: { enabled: false, tokenBudget: 9999 } }))
    setConfigDir(projectDir)
    const second = buildFullPrompt("build", "test-task", taskDir, projectDir)

    expect(second).toBe(first)
  })

  it("produces shorter output when tiers enabled vs disabled", () => {
    // Without tiers (explicitly disabled)
    fs.writeFileSync(path.join(projectDir, "kody.config.json"), JSON.stringify({ agent: {}, contextTiers: { enabled: false } }))
    setConfigDir(projectDir)
    const withoutTiers = buildFullPrompt("build", "test-task", taskDir, projectDir)

    resetProjectConfig()

    // With tiers enabled
    fs.writeFileSync(path.join(projectDir, "kody.config.json"), JSON.stringify({ agent: {}, contextTiers: { enabled: true } }))
    setConfigDir(projectDir)
    const withTiers = buildFullPrompt("build", "test-task", taskDir, projectDir)

    // Tiered version should be shorter because memory is L1 instead of full
    expect(withTiers.length).toBeLessThan(withoutTiers.length)
    // But should still contain the full plan (L2 for build stage)
    expect(withTiers).toContain("Detailed Design")
  })

  it("respects token budget", () => {
    fs.writeFileSync(path.join(projectDir, "kody.config.json"), JSON.stringify({ agent: {}, contextTiers: { enabled: true, tokenBudget: 100 } }))
    setConfigDir(projectDir)
    const result = buildFullPrompt("build", "test-task", taskDir, projectDir)
    // 100 tokens * 4 chars = 400 chars + truncation message
    expect(result.length).toBeLessThan(500)
    expect(result).toContain("truncated to fit token budget")
  })

  it("includes overview indicator for tiered memory", () => {
    fs.writeFileSync(path.join(projectDir, "kody.config.json"), JSON.stringify({ agent: {}, contextTiers: { enabled: true } }))
    setConfigDir(projectDir)
    const result = buildFullPrompt("build", "test-task", taskDir, projectDir)
    expect(result).toContain("overview")
  })
})
