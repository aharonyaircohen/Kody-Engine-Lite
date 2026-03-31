import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { detectBasicConfig, buildConfig, detectArchitectureBasic } from "../../src/bin/cli.js"

describe("detectBasicConfig", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-init-test-"))
    // Init a git repo so git commands don't fail catastrophically
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("detects pnpm from lock file", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "")
    const config = detectBasicConfig(tmpDir)
    expect(config.pm).toBe("pnpm")
  })

  it("detects yarn from lock file", () => {
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "")
    const config = detectBasicConfig(tmpDir)
    expect(config.pm).toBe("yarn")
  })

  it("detects bun from lock file", () => {
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "")
    const config = detectBasicConfig(tmpDir)
    expect(config.pm).toBe("bun")
  })

  it("detects npm from package-lock.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}")
    const config = detectBasicConfig(tmpDir)
    expect(config.pm).toBe("npm")
  })

  it("defaults to pnpm when no lock file", () => {
    const config = detectBasicConfig(tmpDir)
    expect(config.pm).toBe("pnpm")
  })

  it("defaults branch to main when no git remote", () => {
    const config = detectBasicConfig(tmpDir)
    expect(config.defaultBranch).toBe("main")
  })

  it("returns empty owner/repo when no git remote", () => {
    const config = detectBasicConfig(tmpDir)
    expect(config.owner).toBe("")
    expect(config.repo).toBe("")
  })
})

describe("buildConfig", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-config-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("generates config with correct structure", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { lint: "eslint .", "test:unit": "vitest run" },
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main",
      owner: "test-org",
      repo: "test-repo",
      pm: "pnpm",
    }) as Record<string, unknown>

    expect(config).toHaveProperty("$schema")
    expect(config).toHaveProperty("quality")
    expect(config).toHaveProperty("git")
    expect(config).toHaveProperty("github")
    expect(config).toHaveProperty("agent")
  })

  it("detects lint script from package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { lint: "eslint ." },
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const quality = (config as Record<string, Record<string, string>>).quality
    expect(quality.lint).toBe("pnpm lint")
  })

  it("detects test:unit script", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { "test:unit": "vitest run --reporter=verbose" },
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "npm",
    })
    const quality = (config as Record<string, Record<string, string>>).quality
    expect(quality.testUnit).toBe("npm test:unit")
  })

  it("falls back to test script when test:unit missing", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { test: "vitest" },
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const quality = (config as Record<string, Record<string, string>>).quality
    expect(quality.testUnit).toBe("pnpm test")
  })

  it("detects lint:fix script", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { "lint:fix": "eslint . --fix" },
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "dev", owner: "o", repo: "r", pm: "yarn",
    })
    const quality = (config as Record<string, Record<string, string>>).quality
    expect(quality.lintFix).toBe("yarn lint:fix")
  })

  it("returns empty string for missing scripts", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: {},
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const quality = (config as Record<string, Record<string, string>>).quality
    expect(quality.lint).toBe("")
    expect(quality.lintFix).toBe("")
  })

  it("detects typecheck from typescript devDependency", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: {},
      devDependencies: { typescript: "^5.0.0" },
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const quality = (config as Record<string, Record<string, string>>).quality
    expect(quality.typecheck).toBe("pnpm tsc --noEmit")
  })

  it("prefers typecheck script over fallback", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "^5.0.0" },
    }))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const quality = (config as Record<string, Record<string, string>>).quality
    expect(quality.typecheck).toBe("pnpm typecheck")
  })

  it("sets git and github from basic config", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({}))

    const config = buildConfig(tmpDir, {
      defaultBranch: "dev",
      owner: "my-org",
      repo: "my-repo",
      pm: "pnpm",
    })
    const git = (config as Record<string, Record<string, string>>).git
    const github = (config as Record<string, Record<string, string>>).github
    expect(git.defaultBranch).toBe("dev")
    expect(github.owner).toBe("my-org")
    expect(github.repo).toBe("my-repo")
  })

  it("sets agent defaults", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({}))

    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const agent = (config as Record<string, Record<string, unknown>>).agent
    expect(agent.modelMap).toEqual({ cheap: "haiku", mid: "sonnet", strong: "opus" })
  })

  it("handles missing package.json gracefully", () => {
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    expect(config).toHaveProperty("quality")
    expect(config).toHaveProperty("git")
  })

  it("auto-configures MCP for Next.js projects (playwright auto-injected at runtime)", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "15.0.0", react: "19.0.0" },
    }))
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const mcp = (config as Record<string, any>).mcp
    expect(mcp).toBeDefined()
    expect(mcp.enabled).toBe(true)
    expect(mcp.servers).toEqual({})
    expect(mcp.stages).toEqual(["build", "review"])
    expect(mcp.devServer.url).toBe("http://localhost:3000")
  })

  it("auto-configures devServer for Next.js projects", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "15.0.0" },
    }))
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const mcp = (config as Record<string, any>).mcp
    expect(mcp.devServer).toBeDefined()
    expect(mcp.devServer.command).toBe("pnpm dev")
    expect(mcp.devServer.url).toBe("http://localhost:3000")
  })

  it("auto-configures MCP for React (Vite) projects", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "6.0.0" },
    }))
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const mcp = (config as Record<string, any>).mcp
    expect(mcp).toBeDefined()
    expect(mcp.enabled).toBe(true)
    expect(mcp.devServer.url).toBe("http://localhost:5173")
  })

  it("auto-configures MCP for Vue projects", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      dependencies: { vue: "3.5.0" },
      devDependencies: { vite: "6.0.0" },
    }))
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const mcp = (config as Record<string, any>).mcp
    expect(mcp).toBeDefined()
    expect(mcp.enabled).toBe(true)
  })

  it("auto-configures MCP for Svelte projects", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "vite dev" },
      devDependencies: { svelte: "5.0.0", vite: "6.0.0" },
    }))
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const mcp = (config as Record<string, any>).mcp
    expect(mcp).toBeDefined()
    expect(mcp.enabled).toBe(true)
  })

  it("does NOT auto-configure MCP for backend-only projects", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { start: "node dist/index.js" },
      dependencies: { express: "4.18.0" },
    }))
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    const mcp = (config as Record<string, any>).mcp
    expect(mcp).toBeUndefined()
  })

  it("detects Vite port 5173 vs Next.js port 3000", () => {
    // Vite project
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "6.0.0" },
    }))
    const viteConfig = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    expect((viteConfig as any).mcp.devServer.url).toBe("http://localhost:5173")

    // Next.js project
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "15.0.0" },
    }))
    const nextConfig = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "pnpm",
    })
    expect((nextConfig as any).mcp.devServer.url).toBe("http://localhost:3000")
  })

  it("uses dev script from package.json for devServer command", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: { dev: "next dev --turbo" },
      dependencies: { next: "15.0.0" },
    }))
    const config = buildConfig(tmpDir, {
      defaultBranch: "main", owner: "o", repo: "r", pm: "yarn",
    })
    expect((config as any).mcp.devServer.command).toBe("yarn dev")
  })
})

describe("detectArchitectureBasic", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-arch-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("detects Next.js framework", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { next: "15.0.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("Next.js"))).toBe(true)
  })

  it("detects React when no Next.js", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { react: "19.0.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("React"))).toBe(true)
  })

  it("detects Express framework", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { express: "4.18.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("Express"))).toBe(true)
  })

  it("detects TypeScript", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      devDependencies: { typescript: "5.5.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("TypeScript"))).toBe(true)
  })

  it("detects vitest testing framework", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      devDependencies: { vitest: "1.0.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("vitest"))).toBe(true)
  })

  it("detects jest testing framework", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      devDependencies: { jest: "29.0.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("jest"))).toBe(true)
  })

  it("detects Prisma ORM", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { "@prisma/client": "5.0.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("Prisma"))).toBe(true)
  })

  it("detects Payload CMS", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { payload: "3.0.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("Payload CMS"))).toBe(true)
  })

  it("detects Tailwind CSS", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      devDependencies: { tailwindcss: "3.4.0" },
    }))
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("Tailwind CSS"))).toBe(true)
  })

  it("detects pnpm from lock file", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({}))
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "")
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("pnpm"))).toBe(true)
  })

  it("detects yarn from lock file", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({}))
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "")
    const items = detectArchitectureBasic(tmpDir)
    expect(items.some(i => i.includes("yarn"))).toBe(true)
  })

  it("detects multiple technologies", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { next: "15.0.0", tailwindcss: "3.4.0" },
      devDependencies: { typescript: "5.5.0", vitest: "1.0.0", eslint: "9.0.0" },
    }))
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "")
    const items = detectArchitectureBasic(tmpDir)
    expect(items.length).toBeGreaterThanOrEqual(5)
  })

  it("returns empty array without package.json", () => {
    const items = detectArchitectureBasic(tmpDir)
    expect(items).toEqual([])
  })

  it("handles invalid package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "not json")
    const items = detectArchitectureBasic(tmpDir)
    expect(items).toEqual([])
  })
})
