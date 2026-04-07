/**
 * Folder-scoped sub-agent detection and generation.
 *
 * Detects project structure (monorepo, multi-package, logical separation)
 * and generates per-folder sub-agents with project-specific conventions.
 */

import * as fs from "fs"
import * as path from "path"

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".kody", ".claude",
  ".turbo", ".nx", "coverage", "__pycache__", ".venv", "venv",
])

/** Detected folder scope with extracted context */
export interface FolderScope {
  name: string            // e.g. "server", "web", "admin"
  path: string            // e.g. "server/"
  type: "workspace" | "multi-package" | "logical"
  packageJson: Record<string, unknown> | null
  framework: string | null
  dependencies: string[]
  fileCount: number
  sampleFiles: string[]   // relative paths to sample source files
  importPatterns: string[]
  exportStyle: "named" | "default" | "mixed"
  hasTests: boolean
  testFramework: string | null
  linterConfig: Record<string, unknown> | null
  tsconfig: Record<string, unknown> | null
  pathAliases: Record<string, string>  // alias -> path
  conventions: string[]   // extracted conventions
  constraints: string[]    // extracted constraints
}

/** Detection result */
export interface StructureDetection {
  structureType: "monorepo" | "multi-package" | "logical" | "single"
  scopes: FolderScope[]
  rootPackageJson: Record<string, unknown> | null
}

// ─── Structure Detection ───────────────────────────────────────────────────

/**
 * Detect project structure:
 * - Monorepo: pnpm-workspace.yaml, package.json#workspaces, turbo.json, nx.json
 * - Multi-package: top-level dirs with own package.json
 * - Logical: top-level dirs with >5 code files
 * - Single: single flat src/ — skip folder scoping
 */
export function detectProjectStructure(cwd: string): StructureDetection {
  const rootPackageJson = readPackageJson(cwd)

  // Check for monorepo indicators
  if (hasMonorepoIndicators(cwd)) {
    return detectMonorepoScopes(cwd, rootPackageJson)
  }

  // Check for multi-package (top-level dirs with own package.json)
  const multiPackageScopes = detectMultiPackageScopes(cwd)
  if (multiPackageScopes.length > 0) {
    return {
      structureType: "multi-package",
      scopes: multiPackageScopes,
      rootPackageJson,
    }
  }

  // Check for logical separation (>5 code files in top-level dirs)
  const logicalScopes = detectLogicalScopes(cwd)
  if (logicalScopes.length > 0) {
    return {
      structureType: "logical",
      scopes: logicalScopes,
      rootPackageJson,
    }
  }

  // Single flat src/
  return {
    structureType: "single",
    scopes: [],
    rootPackageJson,
  }
}

function hasMonorepoIndicators(cwd: string): boolean {
  return (
    fs.existsSync(path.join(cwd, "pnpm-workspace.yaml")) ||
    fs.existsSync(path.join(cwd, "turbo.json")) ||
    fs.existsSync(path.join(cwd, "nx.json")) ||
    fs.existsSync(path.join(cwd, "lerna.json")) ||
    (Array.isArray(readPackageJson(cwd)?.workspaces) && (readPackageJson(cwd)?.workspaces as unknown[])?.length > 0)
  )
}

function detectMonorepoScopes(cwd: string, rootPkg: Record<string, unknown> | null): StructureDetection {
  const scopes: FolderScope[] = []

  // Read packages from pnpm-workspace.yaml
  let packageDirs: string[] = []
  const workspaceYaml = path.join(cwd, "pnpm-workspace.yaml")
  if (fs.existsSync(workspaceYaml)) {
    try {
      const content = fs.readFileSync(workspaceYaml, "utf-8")
      // Simple YAML parsing for packages field
      const match = content.match(/packages:\s*\n\s*-\s*['"]?(.+?)['"]?\s*\n/g)
      if (match) {
        for (const m of match) {
          const dir = m.match(/-\s*['"]?(.+?)['"]?/)?.[1]
          if (dir) packageDirs.push(dir)
        }
      }
    } catch { /* ignore */ }
  }

  // Fallback: read workspaces from root package.json
  if (packageDirs.length === 0 && rootPkg?.workspaces) {
    packageDirs = rootPkg.workspaces as string[]
  }

  // Detect from package.json files in packages/ or apps/
  const scanDirs = packageDirs.length > 0 ? packageDirs : ["packages", "apps"]
  for (const scanDir of scanDirs) {
    const fullDir = path.join(cwd, scanDir)
    if (!fs.existsSync(fullDir)) continue

    try {
      const entries = fs.readdirSync(fullDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue
        const pkgJson = readPackageJson(path.join(fullDir, entry.name))
        if (pkgJson) {
          const scope = buildFolderScope(entry.name, scanDir + "/" + entry.name + "/", pkgJson, cwd)
          if (scope) scopes.push(scope)
        }
      }
    } catch { /* ignore */ }
  }

  // Also check root-level package directories (common in some monorepos)
  const rootEntries = fs.readdirSync(cwd, { withFileTypes: true })
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const pkgJson = readPackageJson(path.join(cwd, entry.name))
    if (pkgJson) {
      const scope = buildFolderScope(entry.name, entry.name + "/", pkgJson, cwd)
      if (scope) scopes.push(scope)
    }
  }

  return {
    structureType: scopes.length > 0 ? "monorepo" : "single",
    scopes,
    rootPackageJson: rootPkg,
  }
}

function detectMultiPackageScopes(cwd: string): FolderScope[] {
  const scopes: FolderScope[] = []

  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      const pkgJson = readPackageJson(path.join(cwd, entry.name))
      if (pkgJson) {
        const scope = buildFolderScope(entry.name, entry.name + "/", pkgJson, cwd)
        if (scope) scopes.push(scope)
      }
    }
  } catch { /* ignore */ }

  return scopes
}

function detectLogicalScopes(cwd: string): FolderScope[] {
  const scopes: FolderScope[] = []

  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue

      const dirPath = path.join(cwd, entry.name)
      const codeFiles = countCodeFiles(dirPath)

      if (codeFiles >= 5) {
        // Has enough code files to be considered a logical scope
        const pkgJson = readPackageJson(dirPath)
        const scope = buildFolderScope(entry.name, entry.name + "/", pkgJson, cwd)
        if (scope) scopes.push(scope)
      }
    }
  } catch { /* ignore */ }

  return scopes
}

function countCodeFiles(dir: string): number {
  let count = 0
  try {
    const extensions = /\.(ts|tsx|js|jsx|mjs|cjs)$/
    const excludePattern = /\.(test|spec|config|d)\.(ts|tsx|js|jsx|mjs|cjs)$/

    function walk(d: string, depth: number): void {
      if (depth > 5 || count > 50) return
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue
          const full = path.join(d, entry.name)
          if (entry.isDirectory()) {
            walk(full, depth + 1)
          } else if (extensions.test(entry.name) && !excludePattern.test(entry.name)) {
            count++
          }
        }
      } catch { /* ignore */ }
    }
    walk(dir, 0)
  } catch { /* ignore */ }
  return count
}

// ─── Build Folder Scope ──────────────────────────────────────────────────────

function buildFolderScope(name: string, scopePath: string, pkgJson: Record<string, unknown> | null, cwd: string): FolderScope | null {
  const fullPath = path.join(cwd, scopePath)

  // Get dependencies
  const dependencies: string[] = []
  if (pkgJson) {
    const deps = { ...(pkgJson.dependencies as Record<string, string> ?? {}), ...(pkgJson.devDependencies as Record<string, string> ?? {}) }
    dependencies.push(...Object.keys(deps))
  }

  // Detect framework
  const framework = detectFramework(dependencies)

  // Sample files and patterns
  const sampleFiles = gatherSampleFiles(fullPath, 10)
  const importPatterns = extractImportPatterns(fullPath, sampleFiles)
  const exportStyle = detectExportStyle(fullPath, sampleFiles)
  const hasTests = checkHasTests(fullPath)
  const testFramework = detectTestFramework(fullPath)

  // Config files
  const linterConfig = readLinterConfig(fullPath)
  const tsconfig = readTsConfig(fullPath)
  const pathAliases = extractPathAliases(tsconfig)

  // Extract conventions and constraints from code
  const conventions = extractConventions(fullPath, sampleFiles, exportStyle, pathAliases)
  const constraints = extractConstraints(linterConfig, fullPath, sampleFiles)

  return {
    name,
    path: scopePath,
    type: "logical",
    packageJson: pkgJson,
    framework,
    dependencies,
    fileCount: countCodeFiles(fullPath),
    sampleFiles,
    importPatterns,
    exportStyle,
    hasTests,
    testFramework,
    linterConfig,
    tsconfig,
    pathAliases,
    conventions,
    constraints,
  }
}

// ─── Package.json Reader ───────────────────────────────────────────────────

function readPackageJson(dir: string): Record<string, unknown> | null {
  const pkgPath = path.join(dir, "package.json")
  if (!fs.existsSync(pkgPath)) return null
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>
  } catch {
    return null
  }
}

// ─── Framework Detection ───────────────────────────────────────────────────

function detectFramework(dependencies: string[]): string | null {
  const frameworkMap: Record<string, string[]> = {
    "next": ["next"],
    "react": ["react", "@types/react"],
    "vue": ["vue", "@vue/"],
    "nuxt": ["@nuxt/", "nuxt"],
    "svelte": ["svelte"],
    "angular": ["@angular/core"],
    "express": ["express"],
    "fastify": ["fastify"],
    "nest": ["@nestjs/"],
    "prisma": ["prisma", "@prisma/client"],
    "drizzle": ["drizzle-orm"],
    "payload": ["payload", "@payloadcms/"],
  }

  for (const [framework, deps] of Object.entries(frameworkMap)) {
    if (deps.some(d => dependencies.some(dep => dep === d || dep.startsWith(d)))) {
      return framework
    }
  }

  return null
}

// ─── Sample Files ─────────────────────────────────────────────────────────

function gatherSampleFiles(dir: string, maxFiles: number): string[] {
  const files: { path: string; size: number }[] = []
  const extensions = /\.(ts|tsx|js|jsx|mjs)$/
  const excludePattern = /\.(test|spec|config|d)\.(ts|tsx|js|jsx|mjs)$/

  try {
    function walk(d: string, depth: number): void {
      if (depth > 4 || files.length >= maxFiles * 2) return
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue
          const full = path.join(d, entry.name)
          if (entry.isDirectory()) {
            walk(full, depth + 1)
          } else if (extensions.test(entry.name) && !excludePattern.test(entry.name)) {
            try {
              const stat = fs.statSync(full)
              if (stat.size >= 100 && stat.size <= 20000) {
                files.push({ path: full, size: stat.size })
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* ignore */ }
    }
    walk(dir, 0)
  } catch { /* ignore */ }

  return files
    .sort((a, b) => b.size - a.size)
    .slice(0, maxFiles)
    .map(f => f.path)
}

// ─── Pattern Extraction ───────────────────────────────────────────────────

function extractImportPatterns(dir: string, sampleFiles: string[]): string[] {
  const patterns: string[] = []
  const seen = new Set<string>()

  for (const file of sampleFiles.slice(0, 5)) {
    try {
      const content = fs.readFileSync(file, "utf-8").slice(0, 3000)
      const importLines = content.split("\n").filter(l => l.trimStart().startsWith("import ")).slice(0, 20)

      for (const line of importLines) {
        // Named imports: import { X } from '...'
        const namedMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"](.+?)['"]/)
        if (namedMatch) {
          const source = namedMatch[2]
          if (!seen.has(source)) {
            seen.add(source)
            if (source.startsWith("@/") || source.startsWith("~/") || source.startsWith("src/")) {
              patterns.push(`alias: ${source}`)
            } else if (!source.startsWith(".")) {
              patterns.push(`package: ${source}`)
            } else {
              patterns.push(`relative: ${source}`)
            }
          }
        }

        // Default imports: import X from '...'
        const defaultMatch = line.match(/import\s+(\w+)\s+from\s+['"](.+?)['"]/)
        if (defaultMatch) {
          const source = defaultMatch[2]
          if (!seen.has(source)) {
            seen.add(source)
            if (!source.startsWith(".") && !source.startsWith("@")) {
              patterns.push(`default: ${source}`)
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  return patterns.slice(0, 20)
}

function detectExportStyle(dir: string, sampleFiles: string[]): "named" | "default" | "mixed" {
  let namedCount = 0
  let defaultCount = 0

  for (const file of sampleFiles.slice(0, 5)) {
    try {
      const content = fs.readFileSync(file, "utf-8")
      namedCount += (content.match(/^export\s+\{/gm) ?? []).length
      namedCount += (content.match(/^export\s+(?:const|function|class|type|interface)\s+/gm) ?? []).length
      defaultCount += (content.match(/^export\s+default\s+/gm) ?? []).length
    } catch { /* ignore */ }
  }

  if (namedCount > defaultCount * 2) return "named"
  if (defaultCount > namedCount * 2) return "default"
  return "mixed"
}

function checkHasTests(dir: string): boolean {
  const testDirs = ["__tests__", "test", "tests", ".test", ".tests"]
  const testExtensions = /\.(test|spec)\.(ts|tsx|js|jsx)$/

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (testDirs.includes(entry.name) || entry.name.includes("test")) return true
        if (checkHasTests(full)) return true
      } else if (testExtensions.test(entry.name)) {
        return true
      }
    }
  } catch { /* ignore */ }

  return false
}

function detectTestFramework(dir: string): string | null {
  const pkg = readPackageJson(dir)
  if (!pkg) return null

  const deps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) }

  if (deps.vitest || deps["@vitest/"]) return "vitest"
  if (deps.jest || deps["@types/jest"]) return "jest"
  if (deps.mocha) return "mocha"
  if (deps.playwright || deps["@playwright/test"]) return "playwright"
  if (deps.ava) return "ava"

  return null
}

// ─── Config Files ─────────────────────────────────────────────────────────

function readLinterConfig(dir: string): Record<string, unknown> | null {
  const candidates = [
    "eslint.config.mjs", "eslint.config.js", ".eslintrc.js", ".eslintrc.json", ".eslintrc",
    ".eslintrc.cjs",
  ]

  for (const name of candidates) {
    const filePath = path.join(dir, name)
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8")
        if (name.endsWith(".json")) {
          return JSON.parse(content) as Record<string, unknown>
        }
        // For JS/mjs files, extract key rules
        const rules: Record<string, unknown> = {}
        const ruleMatches = content.matchAll(/(['"]rules['"]\s*:\s*\{)([\s\S]*?)\}/g)
        for (const match of ruleMatches) {
          // Simple extraction - in practice this would need proper JS parsing
          if (match[2]) {
            try {
              // Try to parse just the rules object
              const rulesStr = "{" + match[2] + "}"
              Object.assign(rules, JSON.parse(rulesStr))
            } catch { /* ignore */ }
          }
        }
        return rules
      } catch { /* ignore */ }
    }
  }

  return null
}

function readTsConfig(dir: string): Record<string, unknown> | null {
  const candidates = ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"]
  for (const name of candidates) {
    const filePath = path.join(dir, name)
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>
      } catch { /* ignore */ }
    }
  }
  return null
}

function extractPathAliases(tsconfig: Record<string, unknown> | null): Record<string, string> {
  if (!tsconfig) return {}

  try {
    const paths = (tsconfig.compilerOptions as Record<string, unknown> | undefined)?.paths as Record<string, string[]> | undefined
    if (!paths) return {}

    const aliases: Record<string, string> = {}
    for (const [key, values] of Object.entries(paths)) {
      if (Array.isArray(values) && values.length > 0) {
        aliases[key] = values[0]
      }
    }
    return aliases
  } catch { /* ignore */ }
  return {}
}

// ─── Convention & Constraint Extraction ──────────────────────────────────

function extractConventions(dir: string, sampleFiles: string[], exportStyle: "named" | "default" | "mixed", pathAliases: Record<string, string>): string[] {
  const conventions: string[] = []

  // Export style convention
  if (exportStyle === "named") {
    conventions.push("Named exports only (no export default)")
  } else if (exportStyle === "default") {
    conventions.push("Default exports preferred")
  }

  // Path aliases
  for (const [alias] of Object.entries(pathAliases)) {
    conventions.push(`Absolute imports with ${alias} alias`)
  }

  // Naming conventions from sample files
  const fileNames = sampleFiles.map(f => path.basename(f))
  const camelCase = fileNames.filter(f => /^[a-z][a-zA-Z0-9]*\.(ts|tsx|js|jsx)$/.test(f))
  const pascalCase = fileNames.filter(f => /^[A-Z][a-zA-Z0-9]*\.(ts|tsx|js|jsx)$/.test(f))

  if (camelCase.length > pascalCase.length && pascalCase.length > 0) {
    conventions.push("camelCase for files, PascalCase for classes/components")
  } else if (pascalCase.length > 0) {
    conventions.push("PascalCase for component/class files")
  }

  return conventions
}

function extractConstraints(linterConfig: Record<string, unknown> | null, dir: string, sampleFiles: string[]): string[] {
  const constraints: string[] = []

  if (linterConfig) {
    // Extract meaningful rules as constraints
    const rules = linterConfig.rules ?? linterConfig
    if (rules && typeof rules === "object") {
      for (const [rule, value] of Object.entries(rules)) {
        if (value === false || (typeof value === "object" && (value as Record<string, unknown>).disabled === true)) {
          continue // Skip disabled rules
        }

        if (rule.includes("no-console") || rule.includes("no-console")) {
          constraints.push("NEVER use console.log — use a logger instead")
        }
        if (rule.includes("no-any") || rule.includes("@typescript-eslint/no-explicit-any")) {
          constraints.push("NEVER use 'any' type — use proper typing")
        }
        if (rule.includes("max-len")) {
          constraints.push("Respect line length limits from linter config")
        }
      }
    }
  }

  // Check for specific anti-patterns in code
  for (const file of sampleFiles.slice(0, 3)) {
    try {
      const content = fs.readFileSync(file, "utf-8")

      // Check for console.log usage
      if (/console\.(log|debug|info|warn|error)\s*\(/.test(content)) {
        if (!constraints.some(c => c.includes("console"))) {
          constraints.push("Use a logger (e.g., pino, winston) instead of console methods")
        }
      }

      // Check for raw SQL
      if (/sql`|execute\s*\(\s*['"`]/i.test(content)) {
        constraints.push("NEVER write raw SQL — use the ORM or query builder")
      }
    } catch { /* ignore */ }
  }

  return constraints
}
