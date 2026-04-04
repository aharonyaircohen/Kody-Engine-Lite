import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  gatherArchitectureContext,
  gatherConventionsContext,
  gatherPatternsContext,
  gatherDomainContext,
  gatherTestingContext,
  MEMORY_FILES,
  ROUND2_TASKS,
} from "../../src/bin/bootstrap-context.js"

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-test-"))
  return dir
}

function writeFile(base: string, rel: string, content: string): void {
  const full = path.join(base, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe("MEMORY_FILES constant", () => {
  it("contains all 5 expected file names", () => {
    expect(MEMORY_FILES).toEqual([
      "architecture",
      "conventions",
      "patterns",
      "domain",
      "testing-strategy",
    ])
  })

  it("ROUND2_TASKS covers conventions, patterns, domain, testing-strategy", () => {
    const taskNames = ROUND2_TASKS.map(t => t.name)
    expect(taskNames).toEqual(["conventions", "patterns", "domain", "testing-strategy"])
  })
})

describe("gatherArchitectureContext", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTempProject() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns empty-ish string for empty project", () => {
    const result = gatherArchitectureContext(tmpDir)
    // Should at least have top-level directories section (even if empty)
    expect(typeof result).toBe("string")
  })

  it("includes package.json content", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({
      name: "test-project",
      dependencies: { next: "14.0.0", react: "18.0.0" },
    }))
    const result = gatherArchitectureContext(tmpDir)
    expect(result).toContain("package.json")
    expect(result).toContain("test-project")
  })

  it("includes README content", () => {
    writeFile(tmpDir, "README.md", "# My Project\nThis is a test project")
    const result = gatherArchitectureContext(tmpDir)
    expect(result).toContain("README.md")
    expect(result).toContain("My Project")
  })

  it("includes directory structure", () => {
    writeFile(tmpDir, "src/index.ts", "export default {}")
    writeFile(tmpDir, "src/utils/helpers.ts", "export const foo = 1")
    const result = gatherArchitectureContext(tmpDir)
    expect(result).toContain("src")
  })

  it("includes config files detection", () => {
    writeFile(tmpDir, "vitest.config.ts", "export default {}")
    writeFile(tmpDir, ".prettierrc", "{}")
    const result = gatherArchitectureContext(tmpDir)
    expect(result).toContain("vitest.config.ts")
    expect(result).toContain(".prettierrc")
  })

  it("includes docker files", () => {
    writeFile(tmpDir, "Dockerfile", "FROM node:20")
    const result = gatherArchitectureContext(tmpDir)
    expect(result).toContain("Dockerfile")
    expect(result).toContain("FROM node:20")
  })

  it("includes .env.example", () => {
    writeFile(tmpDir, ".env.example", "DATABASE_URL=\nAPI_KEY=")
    const result = gatherArchitectureContext(tmpDir)
    expect(result).toContain("DATABASE_URL")
  })
})

describe("gatherConventionsContext", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTempProject() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns empty string for empty project", () => {
    const result = gatherConventionsContext(tmpDir)
    expect(typeof result).toBe("string")
  })

  it("includes source file samples from diverse directories", () => {
    // Files must be >= 200 bytes to be included
    const serviceContent = [
      'import { db } from "../db"',
      'import type { User } from "../types"',
      "",
      "export class UserService {",
      "  private db: Database",
      "",
      "  constructor(db: Database) {",
      "    this.db = db",
      "  }",
      "",
      "  async getUser(id: string): Promise<User | null> {",
      '    return db.query("SELECT * FROM users WHERE id = $1", [id])',
      "  }",
      "}",
    ].join("\n")
    const routeContent = [
      'import express from "express"',
      'import { UserService } from "../services/user"',
      "",
      "const router = express.Router()",
      "router.get('/users', async (req, res) => {",
      "  const service = new UserService()",
      "  const users = await service.getAll()",
      "  res.json({ success: true, data: users })",
      "})",
      "export default router",
    ].join("\n")
    writeFile(tmpDir, "src/services/user.ts", serviceContent)
    writeFile(tmpDir, "src/routes/api.ts", routeContent)
    const result = gatherConventionsContext(tmpDir)
    expect(result).toContain("Source File Samples")
  })

  it("includes eslint config", () => {
    writeFile(tmpDir, "eslint.config.mjs", "export default [{ rules: { semi: 'error' } }]")
    const result = gatherConventionsContext(tmpDir)
    expect(result).toContain("ESLint Config")
    expect(result).toContain("semi")
  })

  it("includes prettier config", () => {
    writeFile(tmpDir, ".prettierrc", '{ "semi": false, "singleQuote": true }')
    const result = gatherConventionsContext(tmpDir)
    expect(result).toContain("Prettier Config")
  })

  it("extracts import patterns", () => {
    // File must be >= 200 bytes
    const content = [
      'import { foo } from "./utils"',
      'import path from "path"',
      'import type { Bar } from "./types"',
      'import { readFileSync } from "fs"',
      "",
      "export function processData(input: string): Bar {",
      "  const resolved = path.resolve(input)",
      "  const data = readFileSync(resolved, 'utf-8')",
      "  return foo(data) as Bar",
      "}",
    ].join("\n")
    writeFile(tmpDir, "src/index.ts", content)
    const result = gatherConventionsContext(tmpDir)
    expect(result).toContain("Import Patterns")
  })
})

describe("gatherPatternsContext", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTempProject() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns empty string for empty project", () => {
    const result = gatherPatternsContext(tmpDir)
    expect(result).toBe("")
  })

  it("includes largest source files sorted by size", () => {
    // Create files of different sizes
    writeFile(tmpDir, "src/small.ts", "export const a = 1\n".repeat(20))
    writeFile(tmpDir, "src/large.ts", "export class LargeService {\n" + "  method() { return 1 }\n".repeat(50) + "}\n")
    const result = gatherPatternsContext(tmpDir)
    expect(result).toContain("large.ts")
    expect(result).toContain("Signatures")
  })

  it("extracts function and class signatures", () => {
    writeFile(tmpDir, "src/service.ts", [
      "export class UserService {",
      "  private db: Database",
      "  constructor(db: Database) { this.db = db }",
      "  async findById(id: string) { return null }",
      "}",
      "",
      "export function createService(db: Database): UserService {",
      "  return new UserService(db)",
      "}",
      "",
      "export type UserDTO = { id: string; name: string }",
      "",
      "export const DEFAULT_LIMIT = 100",
    ].join("\n"))
    const result = gatherPatternsContext(tmpDir)
    expect(result).toContain("export class UserService")
    expect(result).toContain("export function createService")
    expect(result).toContain("export type UserDTO")
    expect(result).toContain("export const DEFAULT_LIMIT")
  })
})

describe("gatherDomainContext", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTempProject() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns empty string for empty project", () => {
    const result = gatherDomainContext(tmpDir)
    // Only dependencies section if package.json exists
    expect(typeof result).toBe("string")
  })

  it("finds type definition files", () => {
    writeFile(tmpDir, "src/types/user.ts", "export interface User { id: string; name: string; email: string }")
    const result = gatherDomainContext(tmpDir)
    expect(result).toContain("Type & Model Definitions")
    expect(result).toContain("User")
  })

  it("finds model files by naming convention", () => {
    writeFile(tmpDir, "src/models/order.ts", "export interface Order { id: string; total: number; items: string[] }")
    const result = gatherDomainContext(tmpDir)
    expect(result).toContain("order.ts")
  })

  it("finds schema files by naming convention", () => {
    writeFile(tmpDir, "src/database/schema.ts", "export const users = pgTable('users', { id: serial('id') })")
    const result = gatherDomainContext(tmpDir)
    expect(result).toContain("schema.ts")
  })

  it("finds Prisma schema", () => {
    writeFile(tmpDir, "prisma/schema.prisma", "model User {\n  id Int @id\n  name String\n}")
    const result = gatherDomainContext(tmpDir)
    expect(result).toContain("Schema: prisma/schema.prisma")
    expect(result).toContain("model User")
  })

  it("finds API route files", () => {
    writeFile(tmpDir, "src/app/api/users/route.ts", "export async function GET() { return Response.json([]) }")
    const result = gatherDomainContext(tmpDir)
    expect(result).toContain("API Routes")
  })

  it("finds migration files", () => {
    writeFile(tmpDir, "prisma/migrations/001_init.sql", "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);")
    const result = gatherDomainContext(tmpDir)
    expect(result).toContain("Migration")
    expect(result).toContain("CREATE TABLE")
  })
})

describe("gatherTestingContext", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTempProject() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("returns empty string for empty project", () => {
    const result = gatherTestingContext(tmpDir)
    expect(typeof result).toBe("string")
  })

  it("finds vitest config", () => {
    writeFile(tmpDir, "vitest.config.ts", "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { coverage: { threshold: 80 } } })")
    const result = gatherTestingContext(tmpDir)
    expect(result).toContain("Test Config: vitest.config.ts")
    expect(result).toContain("coverage")
  })

  it("finds sample test files", () => {
    writeFile(tmpDir, "tests/unit/user.test.ts", [
      "import { describe, it, expect } from 'vitest'",
      "describe('UserService', () => {",
      "  it('should create user', () => {",
      "    expect(true).toBe(true)",
      "  })",
      "})",
    ].join("\n"))
    const result = gatherTestingContext(tmpDir)
    expect(result).toContain("Sample Test Files")
    expect(result).toContain("UserService")
  })

  it("finds CI workflow files", () => {
    writeFile(tmpDir, ".github/workflows/ci.yml", "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test")
    const result = gatherTestingContext(tmpDir)
    expect(result).toContain("CI Workflow")
    expect(result).toContain("npm test")
  })

  it("extracts test-related scripts from package.json", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({
      name: "test-project",
      scripts: {
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        lint: "eslint .",
        build: "tsc",
        dev: "vite dev",
      },
    }))
    const result = gatherTestingContext(tmpDir)
    expect(result).toContain("Test Scripts")
    expect(result).toContain("vitest run")
    expect(result).toContain("test:coverage")
    expect(result).toContain("lint")
    // build and dev should NOT be in test scripts
    expect(result).not.toContain('"build"')
    expect(result).not.toContain('"dev"')
  })

  it("categorizes tests (unit, integration, e2e)", () => {
    // Files must be >= 100 bytes
    const unitTest = [
      "import { describe, it, expect } from 'vitest'",
      "import { AuthService } from '../../src/services/auth'",
      "",
      "describe('AuthService unit tests', () => {",
      "  it('should validate token format', () => {",
      "    const service = new AuthService()",
      "    expect(service.validateToken('abc')).toBe(false)",
      "  })",
      "})",
    ].join("\n")
    const integrationTest = [
      "import { describe, it, expect } from 'vitest'",
      "import { createDatabase } from '../../src/db'",
      "",
      "describe('Database integration tests', () => {",
      "  it('should connect to the database', async () => {",
      "    const db = await createDatabase()",
      "    expect(db.isConnected()).toBe(true)",
      "    await db.close()",
      "  })",
      "})",
    ].join("\n")
    const e2eTest = [
      "import { test, expect } from '@playwright/test'",
      "",
      "test('login flow works end to end', async ({ page }) => {",
      "  await page.goto('/login')",
      "  await page.fill('#email', 'test@example.com')",
      "  await page.fill('#password', 'password123')",
      "  await page.click('button[type=submit]')",
      "  await expect(page).toHaveURL('/dashboard')",
      "})",
    ].join("\n")
    writeFile(tmpDir, "tests/unit/auth.test.ts", unitTest)
    writeFile(tmpDir, "tests/integration/db.test.ts", integrationTest)
    writeFile(tmpDir, "tests/e2e/login.test.ts", e2eTest)
    const result = gatherTestingContext(tmpDir)
    expect(result).toContain("auth.test.ts")
    expect(result).toContain("db.test.ts")
    expect(result).toContain("login.test.ts")
  })
})
