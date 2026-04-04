import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"

// ─── File Walker ────────────────────────────────────────────────────────────

interface WalkEntry {
  filePath: string
  size: number
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".kody", ".claude"])

function walkSourceFiles(
  dir: string,
  opts: {
    extensions?: RegExp
    excludePatterns?: RegExp
    minSize?: number
    maxSize?: number
  } = {},
): WalkEntry[] {
  const {
    extensions = /\.(ts|tsx|js|jsx|mjs|cjs)$/,
    excludePatterns = /\.(test|spec|config|d)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    minSize = 100,
    maxSize = 50_000,
  } = opts

  const entries: WalkEntry[] = []

  function walk(d: string, depth: number): void {
    if (depth > 8) return
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
        } else if (extensions.test(entry.name) && !excludePatterns.test(entry.name)) {
          try {
            const stat = fs.statSync(full)
            if (stat.size >= minSize && stat.size <= maxSize) {
              entries.push({ filePath: full, size: stat.size })
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  walk(dir, 0)
  return entries
}

function readFile(filePath: string, maxChars: number): string {
  try {
    return fs.readFileSync(filePath, "utf-8").slice(0, maxChars)
  } catch {
    return ""
  }
}

function readIfExists(cwd: string, rel: string, maxChars = 3000): string | null {
  const p = path.join(cwd, rel)
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8").slice(0, maxChars)
  return null
}

function findFirstExisting(cwd: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const p = path.join(cwd, c)
    if (fs.existsSync(p)) return c
  }
  return null
}

function formatFileSection(relativePath: string, content: string, lang = "typescript"): string {
  return `### ${relativePath}\n\`\`\`${lang}\n${content}\n\`\`\``
}

// ─── Context Gatherers ──────────────────────────────────────────────────────

export function gatherArchitectureContext(cwd: string): string {
  const sections: string[] = []

  // package.json
  const pkgJson = readIfExists(cwd, "package.json", 4000)
  if (pkgJson) sections.push(`## package.json\n${pkgJson}`)

  // tsconfig / jsconfig
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    const content = readIfExists(cwd, f, 1500)
    if (content) { sections.push(`## ${f}\n${content}`); break }
  }

  // README
  const readme = readIfExists(cwd, "README.md", 2500)
  if (readme) sections.push(`## README.md\n${readme}`)

  // CLAUDE.md / AGENTS.md
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const content = readIfExists(cwd, f, 3000)
    if (content) sections.push(`## ${f}\n${content}`)
  }

  // Docker / infrastructure
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "Dockerfile"]) {
    const content = readIfExists(cwd, f, 1000)
    if (content) sections.push(`## ${f}\n${content}`)
  }

  // .env.example (variable names reveal services used)
  const envExample = readIfExists(cwd, ".env.example", 1000)
  if (envExample) sections.push(`## .env.example\n${envExample}`)

  // Directory structure
  try {
    const topDirs = fs.readdirSync(cwd, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map(e => e.name)
    sections.push(`## Top-level directories\n${topDirs.join(", ")}`)

    const srcDir = path.join(cwd, "src")
    if (fs.existsSync(srcDir)) {
      const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true })
      const srcDirs = srcEntries.filter(e => e.isDirectory()).map(e => e.name)
      const srcFiles = srcEntries.filter(e => e.isFile()).map(e => e.name)
      if (srcDirs.length > 0) sections.push(`## src/ subdirectories\n${srcDirs.join(", ")}`)
      if (srcFiles.length > 0) sections.push(`## src/ top-level files\n${srcFiles.join(", ")}`)
    }
  } catch { /* ignore */ }

  // Config files present
  const configFiles: string[] = []
  for (const f of [
    ".env.example", "CLAUDE.md", "AGENTS.md", ".ai-docs",
    "vitest.config.ts", "vitest.config.mts", "jest.config.ts", "jest.config.js",
    "playwright.config.ts", ".eslintrc.js", "eslint.config.mjs", ".prettierrc",
    "drizzle.config.ts", "prisma/schema.prisma", "next.config.ts", "next.config.js",
    "vite.config.ts", "tailwind.config.ts", "tailwind.config.js",
  ]) {
    if (fs.existsSync(path.join(cwd, f))) configFiles.push(f)
  }
  if (configFiles.length) sections.push(`## Config files present\n${configFiles.join(", ")}`)

  return sections.join("\n\n")
}

export function gatherConventionsContext(cwd: string): string {
  const sections: string[] = []
  const srcDir = fs.existsSync(path.join(cwd, "src")) ? path.join(cwd, "src") : cwd

  // Diverse source file samples (pick from different subdirectories)
  const allFiles = walkSourceFiles(srcDir, { minSize: 200, maxSize: 5000 })
  const byDir = new Map<string, WalkEntry[]>()
  for (const f of allFiles) {
    const dir = path.dirname(f.filePath)
    const list = byDir.get(dir) ?? []
    list.push(f)
    byDir.set(dir, list)
  }

  // Pick one file from each directory, prioritize larger files
  const selected: WalkEntry[] = []
  for (const [, files] of byDir) {
    files.sort((a, b) => b.size - a.size)
    if (files[0]) selected.push(files[0])
  }
  selected.sort((a, b) => b.size - a.size)
  const sampleFiles = selected.slice(0, 6)

  if (sampleFiles.length > 0) {
    const fileSections = sampleFiles.map(f => {
      const rel = path.relative(cwd, f.filePath)
      const content = readFile(f.filePath, 2000)
      return formatFileSection(rel, content)
    })
    sections.push(`## Source File Samples\n${fileSections.join("\n\n")}`)
  }

  // Linter config
  const eslintFile = findFirstExisting(cwd, [
    "eslint.config.mjs", "eslint.config.js", ".eslintrc.js", ".eslintrc.json", ".eslintrc",
  ])
  if (eslintFile) {
    const content = readIfExists(cwd, eslintFile, 2000)
    if (content) sections.push(`## ESLint Config (${eslintFile})\n${content}`)
  }

  // Prettier config
  const prettierFile = findFirstExisting(cwd, [
    ".prettierrc", ".prettierrc.json", "prettier.config.js", "prettier.config.mjs",
  ])
  if (prettierFile) {
    const content = readIfExists(cwd, prettierFile, 1000)
    if (content) sections.push(`## Prettier Config (${prettierFile})\n${content}`)
  }

  // tsconfig for path aliases, strict mode
  const tsconfig = readIfExists(cwd, "tsconfig.json", 1500)
  if (tsconfig) sections.push(`## tsconfig.json\n${tsconfig}`)

  // Import style sampling: first 30 lines of a few files to see import patterns
  const importSamples: string[] = []
  for (const f of sampleFiles.slice(0, 4)) {
    const content = readFile(f.filePath, 3000)
    const importLines = content.split("\n").filter(l => l.startsWith("import ")).slice(0, 10)
    if (importLines.length > 0) {
      const rel = path.relative(cwd, f.filePath)
      importSamples.push(`// ${rel}\n${importLines.join("\n")}`)
    }
  }
  if (importSamples.length > 0) {
    sections.push(`## Import Patterns\n\`\`\`typescript\n${importSamples.join("\n\n")}\n\`\`\``)
  }

  return sections.join("\n\n")
}

export function gatherPatternsContext(cwd: string): string {
  const sections: string[] = []
  const srcDir = fs.existsSync(path.join(cwd, "src")) ? path.join(cwd, "src") : cwd

  // 8-10 largest source files (these contain core business logic and patterns)
  const allFiles = walkSourceFiles(srcDir, { minSize: 300, maxSize: 20_000 })
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)

  for (const f of allFiles) {
    const rel = path.relative(cwd, f.filePath)
    const content = readFile(f.filePath, 3000)

    // Extract signatures: exports, classes, interfaces, functions, types
    const lines = content.split("\n")
    const signatures = lines.filter(l =>
      /^export\s/.test(l) ||
      /^(abstract\s+)?class\s/.test(l) ||
      /^interface\s/.test(l) ||
      /^(export\s+)?(async\s+)?function\s/.test(l) ||
      /^(export\s+)?type\s+\w/.test(l) ||
      /^(export\s+)?const\s+\w+\s*[=:]/.test(l),
    )

    sections.push(`### ${rel} (${f.size} bytes)\n**Signatures:**\n\`\`\`typescript\n${signatures.join("\n")}\n\`\`\`\n\n**Full (truncated):**\n\`\`\`typescript\n${content}\n\`\`\``)
  }

  return sections.length > 0
    ? `## Largest Source Files (core logic)\n\n${sections.join("\n\n")}`
    : ""
}

export function gatherDomainContext(cwd: string): string {
  const sections: string[] = []

  // Type definition files
  const typeFiles: WalkEntry[] = []
  const typeDirs = ["src/types", "src/interfaces", "types", "src/@types", "src/models", "src/entities", "src/schemas"]
  for (const dir of typeDirs) {
    const full = path.join(cwd, dir)
    if (fs.existsSync(full)) {
      typeFiles.push(...walkSourceFiles(full, {
        extensions: /\.(ts|tsx|d\.ts)$/,
        excludePatterns: /^$/,  // don't exclude anything in type dirs
        minSize: 50,
      }))
    }
  }

  // Also find standalone type files anywhere in src
  const srcDir = path.join(cwd, "src")
  if (fs.existsSync(srcDir)) {
    const allSrc = walkSourceFiles(srcDir, {
      extensions: /\.(ts|tsx)$/,
      excludePatterns: /\.(test|spec|config)\.(ts|tsx)$/,
      minSize: 50,
      maxSize: 10_000,
    })
    for (const f of allSrc) {
      const name = path.basename(f.filePath).toLowerCase()
      if (name.includes("type") || name.includes("interface") || name.includes("schema") ||
          name.includes("model") || name.includes("entity") || name.includes("dto")) {
        typeFiles.push(f)
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>()
  const uniqueTypeFiles = typeFiles.filter(f => {
    if (seen.has(f.filePath)) return false
    seen.add(f.filePath)
    return true
  }).slice(0, 10)

  if (uniqueTypeFiles.length > 0) {
    const fileSections = uniqueTypeFiles.map(f => {
      const rel = path.relative(cwd, f.filePath)
      return formatFileSection(rel, readFile(f.filePath, 2000))
    })
    sections.push(`## Type & Model Definitions\n${fileSections.join("\n\n")}`)
  }

  // Schema files (Prisma, Drizzle, etc.)
  const schemaFiles = [
    "prisma/schema.prisma",
    "drizzle/schema.ts",
    "src/db/schema.ts",
    "src/schema.ts",
    "src/database/schema.ts",
  ]
  for (const f of schemaFiles) {
    const content = readIfExists(cwd, f, 3000)
    if (content) {
      const lang = f.endsWith(".prisma") ? "prisma" : "typescript"
      sections.push(`## Schema: ${f}\n\`\`\`${lang}\n${content}\n\`\`\``)
    }
  }

  // Migration files (latest 3)
  const migrationDirs = ["prisma/migrations", "drizzle", "migrations", "src/migrations"]
  for (const dir of migrationDirs) {
    const full = path.join(cwd, dir)
    if (!fs.existsSync(full)) continue
    try {
      const entries = fs.readdirSync(full, { withFileTypes: true })
        .filter(e => e.isFile() && /\.(sql|ts|js)$/.test(e.name))
        .sort((a, b) => b.name.localeCompare(a.name))  // newest first
        .slice(0, 3)
      for (const entry of entries) {
        const content = readFile(path.join(full, entry.name), 1500)
        if (content) {
          sections.push(`## Migration: ${dir}/${entry.name}\n\`\`\`sql\n${content}\n\`\`\``)
        }
      }
    } catch { /* skip */ }
    break  // only process first found migration dir
  }

  // API route files
  const routeDirs = ["src/app/api", "src/pages/api", "src/routes", "routes", "src/api"]
  for (const dir of routeDirs) {
    const full = path.join(cwd, dir)
    if (!fs.existsSync(full)) continue
    const routeFiles = walkSourceFiles(full, { minSize: 50, maxSize: 10_000 })
      .sort((a, b) => b.size - a.size)
      .slice(0, 8)
    if (routeFiles.length > 0) {
      const fileSections = routeFiles.map(f => {
        const rel = path.relative(cwd, f.filePath)
        return formatFileSection(rel, readFile(f.filePath, 1000))
      })
      sections.push(`## API Routes\n${fileSections.join("\n\n")}`)
    }
    break  // only process first found route dir
  }

  // package.json dependencies section (for ORM/DB identification)
  const pkgJson = readIfExists(cwd, "package.json", 4000)
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson)
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(", ")
      sections.push(`## Dependencies\n${deps}`)
    } catch { /* skip */ }
  }

  return sections.join("\n\n")
}

export function gatherTestingContext(cwd: string): string {
  const sections: string[] = []

  // Test config files
  const testConfigs = [
    "vitest.config.ts", "vitest.config.mts", "vitest.config.js",
    "jest.config.ts", "jest.config.js", "jest.config.json",
    "playwright.config.ts", "playwright.config.js",
    ".nycrc", ".nycrc.json", "c8.config.json",
  ]
  for (const f of testConfigs) {
    const content = readIfExists(cwd, f, 1500)
    if (content) {
      const lang = f.endsWith(".json") ? "json" : "typescript"
      sections.push(`## Test Config: ${f}\n\`\`\`${lang}\n${content}\n\`\`\``)
    }
  }

  // Sample test files (diverse selection)
  const testDirs = ["tests", "test", "__tests__", "src/__tests__", "src"]
  const testFiles: WalkEntry[] = []
  for (const dir of testDirs) {
    const full = path.join(cwd, dir)
    if (!fs.existsSync(full)) continue
    testFiles.push(...walkSourceFiles(full, {
      extensions: /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/,
      excludePatterns: /^$/,  // we want test files
      minSize: 100,
      maxSize: 10_000,
    }))
  }

  // Also walk src for co-located tests
  const srcDir = path.join(cwd, "src")
  if (fs.existsSync(srcDir)) {
    testFiles.push(...walkSourceFiles(srcDir, {
      extensions: /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/,
      excludePatterns: /^$/,
      minSize: 100,
      maxSize: 10_000,
    }))
  }

  // Deduplicate and pick diverse samples
  const seenTest = new Set<string>()
  const uniqueTests = testFiles.filter(f => {
    if (seenTest.has(f.filePath)) return false
    seenTest.add(f.filePath)
    return true
  })

  // Try to pick: 1 unit, 1 integration, 1 e2e (by path heuristics)
  const categorized = {
    unit: uniqueTests.filter(f => f.filePath.includes("/unit/") || f.filePath.includes("__tests__")),
    integration: uniqueTests.filter(f => f.filePath.includes("/integration/")),
    e2e: uniqueTests.filter(f => f.filePath.includes("/e2e/") || f.filePath.includes("playwright")),
    other: uniqueTests,
  }

  const selectedTests: WalkEntry[] = []
  for (const category of [categorized.unit, categorized.integration, categorized.e2e, categorized.other]) {
    if (selectedTests.length >= 4) break
    const sorted = category.sort((a, b) => b.size - a.size)
    for (const f of sorted) {
      if (selectedTests.length >= 4) break
      if (!selectedTests.some(s => s.filePath === f.filePath)) {
        selectedTests.push(f)
      }
    }
  }

  if (selectedTests.length > 0) {
    const fileSections = selectedTests.map(f => {
      const rel = path.relative(cwd, f.filePath)
      return formatFileSection(rel, readFile(f.filePath, 2000))
    })
    sections.push(`## Sample Test Files\n${fileSections.join("\n\n")}`)
  }

  // CI config
  const workflowDir = path.join(cwd, ".github", "workflows")
  if (fs.existsSync(workflowDir)) {
    try {
      const workflows = fs.readdirSync(workflowDir)
        .filter(f => /\.ya?ml$/.test(f))
        .slice(0, 2)
      for (const f of workflows) {
        const content = readFile(path.join(workflowDir, f), 2000)
        if (content) {
          sections.push(`## CI Workflow: .github/workflows/${f}\n\`\`\`yaml\n${content}\n\`\`\``)
        }
      }
    } catch { /* skip */ }
  }

  // package.json test-related scripts
  const pkgJson = readIfExists(cwd, "package.json", 4000)
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson)
      const scripts = pkg.scripts ?? {}
      const testScripts: Record<string, string> = {}
      for (const [name, cmd] of Object.entries(scripts)) {
        if (/test|lint|typecheck|check|coverage|e2e/.test(name)) {
          testScripts[name] = cmd as string
        }
      }
      if (Object.keys(testScripts).length > 0) {
        sections.push(`## Test Scripts (package.json)\n\`\`\`json\n${JSON.stringify(testScripts, null, 2)}\n\`\`\``)
      }
    } catch { /* skip */ }
  }

  return sections.join("\n\n")
}

// ─── Async LLM Caller ──────────────────────────────────────────────────────

export function execClaudeAsync(
  prompt: string,
  model: string,
  cwd: string,
  timeout = 90_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [
      "--print",
      "--model", model,
      "--dangerously-skip-permissions",
    ], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL") }, 5000)
      reject(new Error(`LLM call timed out after ${timeout}ms`))
    }, timeout)

    // Send prompt via stdin
    if (child.stdin) {
      child.stdin.write(prompt, () => {
        child.stdin!.end()
      })
    }

    child.on("exit", (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString().trim()
      if (code === 0 && stdout) {
        resolve(stdout)
      } else {
        const stderr = Buffer.concat(stderrChunks).toString().slice(-1000)
        reject(new Error(`claude exited with code ${code}: ${stderr || "(no output)"}`))
      }
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ─── Memory File Definitions ────────────────────────────────────────────────

export const MEMORY_FILES = [
  "architecture",
  "conventions",
  "patterns",
  "domain",
  "testing-strategy",
] as const

export type MemoryFileName = typeof MEMORY_FILES[number]

export interface MemoryTask {
  name: MemoryFileName
  gatherContext: (cwd: string) => string
  promptRules: string
}

export const ROUND2_TASKS: MemoryTask[] = [
  {
    name: "conventions",
    gatherContext: gatherConventionsContext,
    promptRules: `Rules:
- Extract actual coding patterns from the source files: naming conventions (camelCase, PascalCase, etc.), import style (relative vs alias, named vs default), export patterns
- Document error handling patterns actually used in the codebase
- Note file organization patterns (how code is grouped, file naming conventions)
- Reference linter/formatter config if present
- If CLAUDE.md exists, reference its conventions
- Be SPECIFIC — cite actual file paths and code snippets as examples
- Keep under 40 lines`,
  },
  {
    name: "patterns",
    gatherContext: gatherPatternsContext,
    promptRules: `Rules:
- Identify design patterns actually used: Repository, Factory, Singleton, Observer, Strategy, Middleware, etc.
- Document architectural layers: how code is organized into layers (controllers, services, repositories, etc.)
- Note module boundaries: what depends on what, which modules are entry points vs internal
- Identify reusable abstractions: base classes, utility functions, shared hooks
- For each pattern, cite the specific file(s) where it appears
- Note any anti-patterns or inconsistencies you observe
- Keep under 50 lines`,
  },
  {
    name: "domain",
    gatherContext: gatherDomainContext,
    promptRules: `Rules:
- Document the core domain entities/models and their relationships
- Create a glossary of business terms used in the codebase (class names, type names, key constants)
- Map the data flow: how data enters the system, gets processed, and exits
- Document the API surface: key endpoints, their purpose, request/response shapes
- Note the database schema if visible (tables, relationships, key fields)
- Be SPECIFIC — use actual type names, field names, and file paths from the codebase
- Keep under 50 lines`,
  },
  {
    name: "testing-strategy",
    gatherContext: gatherTestingContext,
    promptRules: `Rules:
- Identify the test framework(s) in use and how they are configured
- Document test organization: where tests live, naming conventions, directory structure
- Note testing patterns: how mocks are set up, fixture patterns, test data strategies
- Document CI pipeline: how tests are run in CI, what quality gates exist
- Identify coverage approach: what tool, what thresholds, what areas are covered
- Note which types of tests exist (unit, integration, e2e) and their relative proportion
- Reference specific test files as examples of the project's testing style
- Keep under 40 lines`,
  },
]
