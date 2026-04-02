import * as fs from "fs"
import * as path from "path"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FrameworkInfo {
  name: string
  version: string | null
  configFile: string | null
}

export interface CollectionInfo {
  name: string
  slug: string
  filePath: string
  fields: string[]
  hasAdmin: boolean
}

export interface AdminComponentInfo {
  name: string
  filePath: string
  usedInCollection: string | null
}

export interface ApiRouteInfo {
  path: string
  methods: string[]
  filePath: string
}

// ─── Framework Detection ──────────────────────────────────────────────────────

export function detectFrameworks(cwd: string): FrameworkInfo[] {
  const frameworks: FrameworkInfo[] = []

  let deps: Record<string, string> = {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
    deps = { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    return frameworks
  }

  if (deps.payload || deps["@payloadcms/next"]) {
    frameworks.push({
      name: "payload-cms",
      version: deps.payload ?? deps["@payloadcms/next"] ?? null,
      configFile: findFile(cwd, ["payload.config.ts", "payload-config.ts", "src/payload.config.ts"]),
    })
  }

  if (deps["next-auth"]) {
    frameworks.push({
      name: "nextauth",
      version: deps["next-auth"] ?? null,
      configFile: findFile(cwd, ["auth.ts", "auth.config.ts", "src/auth.ts", "src/auth.config.ts"]),
    })
  }

  if (deps.prisma || deps["@prisma/client"]) {
    frameworks.push({
      name: "prisma",
      version: deps.prisma ?? deps["@prisma/client"] ?? null,
      configFile: findFile(cwd, ["prisma/schema.prisma"]),
    })
  }

  return frameworks
}

function findFile(cwd: string, candidates: string[]): string | null {
  for (const c of candidates) {
    if (fs.existsSync(path.join(cwd, c))) return c
  }
  return null
}

// ─── Payload CMS Collections ──────────────────────────────────────────────────

const COLLECTION_DIRS = [
  "src/server/payload/collections",
  "src/payload/collections",
  "src/collections",
  "payload/collections",
]

export function discoverPayloadCollections(cwd: string): CollectionInfo[] {
  const collections: CollectionInfo[] = []

  for (const dir of COLLECTION_DIRS) {
    const fullDir = path.join(cwd, dir)
    if (!fs.existsSync(fullDir)) continue

    let files: string[]
    try {
      files = fs.readdirSync(fullDir).filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
    } catch {
      continue
    }

    for (const file of files) {
      try {
        const filePath = path.join(fullDir, file)
        const content = fs.readFileSync(filePath, "utf-8").slice(0, 10_000)

        const slugMatch = content.match(/slug:\s*['"]([a-z0-9-]+)['"]/)
        if (!slugMatch) continue

        const slug = slugMatch[1]
        const name = file.replace(/\.(ts|tsx)$/, "")

        // Extract top-level field names
        const fields: string[] = []
        const fieldMatches = content.matchAll(/name:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)
        for (const m of fieldMatches) {
          if (!fields.includes(m[1])) fields.push(m[1])
        }

        // Check for admin component references
        const hasAdmin = /components:\s*\{/.test(content) ||
          /Field:\s*['"]/.test(content) ||
          /Cell:\s*['"]/.test(content) ||
          /views:\s*\{/.test(content)

        collections.push({
          name,
          slug,
          filePath: path.relative(cwd, filePath),
          fields: fields.slice(0, 20),
          hasAdmin,
        })
      } catch {
        // Skip malformed files
      }
    }
  }

  return collections
}

// ─── Admin Components ─────────────────────────────────────────────────────────

const ADMIN_COMPONENT_DIRS = [
  "src/ui/admin",
  "src/admin/components",
  "src/components/admin",
]

export function discoverAdminComponents(
  cwd: string,
  collections?: CollectionInfo[],
): AdminComponentInfo[] {
  const components: AdminComponentInfo[] = []

  for (const dir of ADMIN_COMPONENT_DIRS) {
    const fullDir = path.join(cwd, dir)
    if (!fs.existsSync(fullDir)) continue

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(fullDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = path.join(fullDir, entry.name)

      let name: string
      let filePath: string

      if (entry.isDirectory()) {
        // Directory with index file (e.g., CourseLessonsSorter/index.tsx)
        const indexFile = ["index.tsx", "index.ts", "index.jsx", "index.js"]
          .find(f => fs.existsSync(path.join(entryPath, f)))
        if (!indexFile) continue
        name = entry.name
        filePath = path.relative(cwd, path.join(entryPath, indexFile))
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        name = entry.name.replace(/\.(tsx?|jsx?)$/, "")
        filePath = path.relative(cwd, entryPath)
      } else {
        continue
      }

      // Try to match component to a collection
      let usedInCollection: string | null = null
      if (collections) {
        for (const col of collections) {
          try {
            const colContent = fs.readFileSync(path.join(cwd, col.filePath), "utf-8")
            if (colContent.includes(name)) {
              usedInCollection = col.slug
              break
            }
          } catch {
            // skip
          }
        }
      }

      components.push({ name, filePath, usedInCollection })
    }
  }

  return components
}

// ─── API Route Scanner ────────────────────────────────────────────────────────

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

export function scanApiRoutes(cwd: string): ApiRouteInfo[] {
  const routes: ApiRouteInfo[] = []
  const appDirs = ["src/app", "app"]

  for (const appDir of appDirs) {
    const apiDir = path.join(cwd, appDir, "api")
    if (!fs.existsSync(apiDir)) continue
    walkApiRoutes(apiDir, "/api", cwd, routes)
    break
  }

  return routes
}

function walkApiRoutes(dir: string, prefix: string, cwd: string, routes: ApiRouteInfo[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  // Check for route file
  const routeFile = entries.find(e => e.isFile() && /^route\.(ts|js|tsx|jsx)$/.test(e.name))
  if (routeFile) {
    try {
      const content = fs.readFileSync(path.join(dir, routeFile.name), "utf-8").slice(0, 5000)
      const methods = HTTP_METHODS.filter(m =>
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(content),
      )
      if (methods.length > 0) {
        routes.push({
          path: prefix,
          methods,
          filePath: path.relative(cwd, path.join(dir, routeFile.name)),
        })
      }
    } catch {
      // skip
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === "node_modules" || entry.name === ".next") continue

    let segment = entry.name
    // Route groups — transparent in URL
    if (segment.startsWith("(") && segment.endsWith(")")) {
      walkApiRoutes(path.join(dir, entry.name), prefix, cwd, routes)
      continue
    }
    // Dynamic segments — check [[...]] before [] to avoid false match
    if (segment.startsWith("[[") && segment.endsWith("]]")) {
      segment = `:${segment.slice(2, -2)}?`
    } else if (segment.startsWith("[") && segment.endsWith("]")) {
      segment = `:${segment.slice(1, -1)}`
    }

    walkApiRoutes(path.join(dir, entry.name), `${prefix}/${segment}`, cwd, routes)
  }
}

// ─── Env Var Scanner ──────────────────────────────────────────────────────────

const BUILTIN_ENV_VARS = new Set([
  "NODE_ENV", "HOME", "PATH", "USER", "SHELL", "TERM", "LANG", "PWD",
  "HOSTNAME", "PORT", "CI", "GITHUB_ACTIONS",
])

export function scanEnvVars(cwd: string): string[] {
  const envFiles = [".env.example", ".env.local.example", ".env.template"]
  for (const envFile of envFiles) {
    const envPath = path.join(cwd, envFile)
    if (!fs.existsSync(envPath)) continue

    try {
      const content = fs.readFileSync(envPath, "utf-8")
      const vars: string[] = []
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=/)
        if (match && !BUILTIN_ENV_VARS.has(match[1])) {
          vars.push(match[1])
        }
      }
      return vars
    } catch {
      return []
    }
  }

  return []
}
