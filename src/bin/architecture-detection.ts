import * as fs from "fs"
import * as path from "path"

export function detectArchitectureBasic(cwd: string): string[] {
  const detected: string[] = []

  const pkgPath = path.join(cwd, "package.json")
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

      if (allDeps.next) detected.push(`- Framework: Next.js ${allDeps.next}`)
      else if (allDeps.react) detected.push(`- Framework: React ${allDeps.react}`)
      else if (allDeps.express) detected.push(`- Framework: Express ${allDeps.express}`)
      else if (allDeps.fastify) detected.push(`- Framework: Fastify ${allDeps.fastify}`)
      else if (allDeps.hono) detected.push(`- Framework: Hono ${allDeps.hono}`)

      if (allDeps.typescript) detected.push(`- Language: TypeScript ${allDeps.typescript}`)

      if (allDeps.vitest) detected.push(`- Testing: vitest ${allDeps.vitest}`)
      else if (allDeps.jest) detected.push(`- Testing: jest ${allDeps.jest}`)

      if (allDeps.eslint) detected.push(`- Linting: eslint ${allDeps.eslint}`)
      if (allDeps.prettier) detected.push(`- Formatting: prettier ${allDeps.prettier}`)

      if (allDeps.prisma || allDeps["@prisma/client"]) detected.push("- ORM: Prisma")
      if (allDeps["drizzle-orm"]) detected.push("- ORM: Drizzle")
      if (allDeps.payload || allDeps["@payloadcms/next"]) detected.push("- CMS: Payload CMS")
      if (allDeps.tailwindcss) detected.push(`- CSS: Tailwind CSS ${allDeps.tailwindcss}`)

      if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) detected.push("- Package manager: pnpm")
      else if (fs.existsSync(path.join(cwd, "yarn.lock"))) detected.push("- Package manager: yarn")
      else if (fs.existsSync(path.join(cwd, "bun.lockb"))) detected.push("- Package manager: bun")
      else if (fs.existsSync(path.join(cwd, "package-lock.json"))) detected.push("- Package manager: npm")

      // Module system
      if (pkg.type === "module") detected.push("- Module system: ESM")
      else detected.push("- Module system: CommonJS")

      // Database
      if (allDeps.pg || allDeps.postgres) detected.push("- Database: PostgreSQL")
    } catch { /* ignore */ }
  }

  // Directory structure
  try {
    const topDirs = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
    if (topDirs.length > 0) detected.push(`- Top-level directories: ${topDirs.join(", ")}`)
  } catch { /* ignore */ }

  // src structure
  const srcDir = path.join(cwd, "src")
  if (fs.existsSync(srcDir)) {
    try {
      const srcDirs = fs.readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name)
      if (srcDirs.length > 0) detected.push(`- src/ structure: ${srcDirs.join(", ")}`)
    } catch { /* ignore */ }
  }

  return detected
}
