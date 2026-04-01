import * as fs from "fs"
import * as path from "path"

export interface QaDiscovery {
  routes: { path: string; group: string }[]
  authFiles: string[]
  loginPage: string | null
  adminPath: string | null
  roles: string[]
  devCommand: string
  devPort: number
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
    if (segment.startsWith("[") && segment.endsWith("]")) {
      segment = `:${segment.slice(1, -1)}`
    }
    if (segment.startsWith("[[") && segment.endsWith("]]")) {
      segment = `:${segment.slice(2, -2)}?`
    }

    scanRoutes(path.join(dir, entry.name), baseDir, `${prefix}/${segment}`, result)
  }
}

export function generateQaGuide(discovery: QaDiscovery): string {
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

  lines.push(
    "## Dev Server",
    "",
    `- Command: \`${discovery.devCommand || "pnpm dev"}\``,
    `- URL: \`http://localhost:${discovery.devPort}\``,
    "",
  )

  return lines.join("\n")
}
