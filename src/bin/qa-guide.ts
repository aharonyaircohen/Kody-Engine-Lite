import * as fs from "fs"
import * as path from "path"
import {
  detectFrameworks,
  discoverPayloadCollections,
  discoverAdminComponents,
  scanApiRoutes,
  scanEnvVars,
} from "./framework-detectors.js"
import type { FrameworkInfo, CollectionInfo, AdminComponentInfo, ApiRouteInfo } from "./framework-detectors.js"

export interface QaDiscovery {
  routes: { path: string; group: string }[]
  authFiles: string[]
  loginPage: string | null
  adminPath: string | null
  roles: string[]
  devCommand: string
  devPort: number

  // Enriched fields
  frameworks: FrameworkInfo[]
  collections: CollectionInfo[]
  adminComponents: AdminComponentInfo[]
  apiRoutes: ApiRouteInfo[]
  envVars: string[]
}

export function discoverQaContext(cwd: string): QaDiscovery {
  const result: QaDiscovery = {
    routes: [],
    authFiles: [],
    loginPage: null,
    adminPath: null,
    roles: [],
    devCommand: "",
    devPort: 3000,
    frameworks: [],
    collections: [],
    adminComponents: [],
    apiRoutes: [],
    envVars: [],
  }

  // Detect dev command and port
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const pm = fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) ? "pnpm"
      : fs.existsSync(path.join(cwd, "yarn.lock")) ? "yarn" : "npm"
    if (pkg.scripts?.dev) result.devCommand = `${pm} dev`
    if (allDeps.next || allDeps.nuxt) result.devPort = 3000
    else if (allDeps.vite) result.devPort = 5173
  } catch { /* ignore */ }

  // Scan for Next.js App Router routes
  const appDirs = ["src/app", "app"]
  for (const appDir of appDirs) {
    const fullAppDir = path.join(cwd, appDir)
    if (!fs.existsSync(fullAppDir)) continue
    scanRoutes(fullAppDir, appDir, "", result)
    break
  }

  // Detect auth-related files
  const authPatterns = ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"]
  for (const p of authPatterns) {
    if (fs.existsSync(path.join(cwd, p))) result.authFiles.push(p)
  }

  // Scan for auth config files
  const authConfigGlobs = [
    "src/app/api/auth", "src/auth", "src/lib/auth", "auth.config.ts", "auth.ts",
    "src/app/api/oauth",
  ]
  for (const g of authConfigGlobs) {
    if (fs.existsSync(path.join(cwd, g))) result.authFiles.push(g)
  }

  // Scan for role definitions in common locations
  try {
    const rolePaths = [
      "src/types", "src/lib", "src/utils", "src/constants",
      "src/access", "src/collections",
    ]
    for (const rp of rolePaths) {
      const dir = path.join(cwd, rp)
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(dir, f), "utf-8").slice(0, 5000)
          const roleMatches = content.match(/(?:role|Role|ROLE)\s*[=:]\s*['"](\w+)['"]/g)
          if (roleMatches) {
            for (const m of roleMatches) {
              const val = m.match(/['"](\w+)['"]/)
              if (val && !result.roles.includes(val[1])) result.roles.push(val[1])
            }
          }
          const enumMatch = content.match(/(?:enum|type)\s+\w*[Rr]ole\w*\s*[={]([^}]+)/s)
          if (enumMatch) {
            const vals = enumMatch[1].match(/['"](\w+)['"]/g)
            if (vals) {
              for (const v of vals) {
                const clean = v.replace(/['"]/g, "")
                if (!result.roles.includes(clean)) result.roles.push(clean)
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // ── Enriched discovery ──
  result.frameworks = detectFrameworks(cwd)

  const hasPayload = result.frameworks.some(f => f.name === "payload-cms")
  if (hasPayload) {
    result.collections = discoverPayloadCollections(cwd)
  }

  result.adminComponents = discoverAdminComponents(cwd, result.collections.length > 0 ? result.collections : undefined)
  result.apiRoutes = scanApiRoutes(cwd)
  result.envVars = scanEnvVars(cwd)

  return result
}

function scanRoutes(dir: string, baseDir: string, prefix: string, result: QaDiscovery): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return }

  const hasPage = entries.some(e => e.isFile() && /^page\.(tsx?|jsx?)$/.test(e.name))
  if (hasPage) {
    const routePath = prefix || "/"
    const group = prefix.startsWith("/admin") ? "admin"
      : prefix.includes("/login") ? "auth"
      : prefix.includes("/signup") ? "auth"
      : prefix.includes("/api") ? "api"
      : "frontend"

    result.routes.push({ path: routePath, group })

    if (prefix.includes("/login")) result.loginPage = routePath
    if (prefix.startsWith("/admin") && !result.adminPath) result.adminPath = prefix
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === "node_modules" || entry.name === ".next") continue

    let segment = entry.name
    if (segment.startsWith("(") && segment.endsWith(")")) {
      scanRoutes(path.join(dir, entry.name), baseDir, prefix, result)
      continue
    }
    // Check [[...]] before [] to avoid false match
    if (segment.startsWith("[[") && segment.endsWith("]]")) {
      segment = `:${segment.slice(2, -2)}?`
    } else if (segment.startsWith("[") && segment.endsWith("]")) {
      segment = `:${segment.slice(1, -1)}`
    }

    scanRoutes(path.join(dir, entry.name), baseDir, `${prefix}/${segment}`, result)
  }
}

// ─── Fallback Generator (renamed from generateQaGuide) ─────────────────────

export function generateQaGuideFallback(discovery: QaDiscovery): string {
  const lines: string[] = ["# QA Guide", "", "## Authentication", ""]

  if (discovery.loginPage) {
    lines.push(`- Login page: \`${discovery.loginPage}\``)
  }

  lines.push(
    "",
    "### Test Accounts",
    "<!-- Fill in your test/preview environment credentials below -->",
    "| Role | Email | Password |",
    "|------|-------|----------|",
    "| Admin | admin@example.com | CHANGE_ME |",
    "| User | user@example.com | CHANGE_ME |",
    "",
    "### Login Steps",
    `1. Navigate to \`${discovery.loginPage ?? "/login"}\``,
    "2. Enter credentials from the test accounts table above",
    "3. Submit the login form",
    "4. Verify redirect to dashboard or home page",
  )

  if (discovery.authFiles.length > 0) {
    lines.push("", "### Auth Files")
    for (const f of discovery.authFiles) {
      lines.push(`- \`${f}\``)
    }
  }

  if (discovery.roles.length > 0) {
    lines.push("", "## Roles", "")
    for (const role of discovery.roles) {
      lines.push(`- \`${role}\``)
    }
  }

  lines.push("", "## Key Pages", "")

  const groups: Record<string, string[]> = {}
  for (const route of discovery.routes) {
    if (!groups[route.group]) groups[route.group] = []
    groups[route.group].push(route.path)
  }

  for (const [group, routes] of Object.entries(groups)) {
    lines.push(`### ${group.charAt(0).toUpperCase() + group.slice(1)}`)
    const sorted = routes.sort()
    for (const r of sorted.slice(0, 20)) {
      lines.push(`- \`${r}\``)
    }
    if (sorted.length > 20) {
      lines.push(`- ... and ${sorted.length - 20} more`)
    }
    lines.push("")
  }

  // Enriched: Collections
  if (discovery.collections.length > 0) {
    lines.push("## Admin Collections", "")
    for (const col of discovery.collections) {
      lines.push(`### \`/admin/collections/${col.slug}\``)
      lines.push(`- **Name:** ${col.name}`)
      lines.push(`- **Fields:** ${col.fields.join(", ")}`)
      if (col.hasAdmin) lines.push("- **Custom admin components:** yes")
      lines.push("")
    }
  }

  // Enriched: API routes
  if (discovery.apiRoutes.length > 0) {
    lines.push("## API Endpoints", "")
    for (const route of discovery.apiRoutes) {
      lines.push(`- \`${route.methods.join(", ")} ${route.path}\` — \`${route.filePath}\``)
    }
    lines.push("")
  }

  // Enriched: Admin components
  if (discovery.adminComponents.length > 0) {
    lines.push("## Custom Admin Components", "")
    for (const comp of discovery.adminComponents) {
      let line = `- **${comp.name}** (\`${comp.filePath}\`)`
      if (comp.usedInCollection) line += ` — used in \`${comp.usedInCollection}\` collection`
      lines.push(line)
    }
    lines.push("")
  }

  // Enriched: Env vars
  if (discovery.envVars.length > 0) {
    lines.push("## Required Environment Variables", "")
    for (const v of discovery.envVars) {
      lines.push(`- \`${v}\``)
    }
    lines.push("")
  }

  lines.push(
    "## Dev Server",
    "",
    `- Command: \`${discovery.devCommand || "pnpm dev"}\``,
    `- URL: \`http://localhost:${discovery.devPort}\``,
    "",
  )

  return lines.join("\n")
}

/** Keep backward compat — old name delegates to fallback */
export function generateQaGuide(discovery: QaDiscovery): string {
  return generateQaGuideFallback(discovery)
}

// ─── LLM Serialization ─────────────────────────────────────────────────────

const MAX_SERIALIZED_LENGTH = 8000

export function serializeDiscoveryForLLM(discovery: QaDiscovery): string {
  const sections: string[] = []

  // Dev server
  sections.push(`Dev server: ${discovery.devCommand || "pnpm dev"} at http://localhost:${discovery.devPort}`)

  // Auth
  if (discovery.loginPage) sections.push(`Login page: ${discovery.loginPage}`)
  if (discovery.adminPath) sections.push(`Admin panel: ${discovery.adminPath}`)
  if (discovery.roles.length > 0) sections.push(`Roles: ${discovery.roles.join(", ")}`)

  // Frameworks
  if (discovery.frameworks.length > 0) {
    sections.push(`\nFrameworks: ${discovery.frameworks.map(f => `${f.name}${f.version ? ` (${f.version})` : ""}`).join(", ")}`)
  }

  // Collections (cap at 15)
  if (discovery.collections.length > 0) {
    sections.push("\nCollections (Payload CMS):")
    for (const col of discovery.collections.slice(0, 15)) {
      const fields = col.fields.slice(0, 10).join(", ")
      let line = `- ${col.slug}: fields=[${fields}]`
      if (col.hasAdmin) line += " (has custom admin components)"
      line += ` — ${col.filePath}`
      sections.push(line)
    }
    if (discovery.collections.length > 15) {
      sections.push(`- ... and ${discovery.collections.length - 15} more collections`)
    }
  }

  // Admin components (cap at 10)
  if (discovery.adminComponents.length > 0) {
    sections.push("\nCustom Admin Components:")
    for (const comp of discovery.adminComponents.slice(0, 10)) {
      let line = `- ${comp.name} (${comp.filePath})`
      if (comp.usedInCollection) line += ` → used in "${comp.usedInCollection}" collection`
      sections.push(line)
    }
  }

  // API routes (cap at 20)
  if (discovery.apiRoutes.length > 0) {
    sections.push("\nAPI Routes:")
    for (const route of discovery.apiRoutes.slice(0, 20)) {
      sections.push(`- ${route.methods.join("/")} ${route.path} — ${route.filePath}`)
    }
    if (discovery.apiRoutes.length > 20) {
      sections.push(`- ... and ${discovery.apiRoutes.length - 20} more routes`)
    }
  }

  // Frontend routes (cap at 30)
  if (discovery.routes.length > 0) {
    sections.push("\nFrontend Routes:")
    for (const route of discovery.routes.slice(0, 30)) {
      sections.push(`- [${route.group}] ${route.path}`)
    }
    if (discovery.routes.length > 30) {
      sections.push(`- ... and ${discovery.routes.length - 30} more routes`)
    }
  }

  // Env vars
  if (discovery.envVars.length > 0) {
    sections.push(`\nRequired env vars: ${discovery.envVars.join(", ")}`)
  }

  let result = sections.join("\n")

  // Truncate at last newline before budget to avoid cutting mid-line
  if (result.length > MAX_SERIALIZED_LENGTH) {
    const cutoff = result.lastIndexOf("\n", MAX_SERIALIZED_LENGTH - 20)
    result = result.slice(0, cutoff > 0 ? cutoff : MAX_SERIALIZED_LENGTH - 20) + "\n... (truncated)"
  }

  return result
}
