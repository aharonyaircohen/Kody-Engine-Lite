import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

export const FRONTEND_DEPS = ["next", "react", "vue", "svelte", "nuxt", "astro", "solid-js", "angular", "@angular/core"]

export function detectBasicConfig(cwd: string): { defaultBranch: string; owner: string; repo: string; pm: string } {
  let pm = "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) pm = "yarn"
  else if (fs.existsSync(path.join(cwd, "bun.lockb"))) pm = "bun"
  else if (!fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) && fs.existsSync(path.join(cwd, "package-lock.json"))) pm = "npm"

  let defaultBranch = "main"
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      encoding: "utf-8", timeout: 5_000, cwd, stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    defaultBranch = ref.replace("refs/remotes/origin/", "")
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/dev"], {
        encoding: "utf-8", timeout: 5_000, cwd, stdio: ["pipe", "pipe", "pipe"],
      })
      defaultBranch = "dev"
    } catch { /* keep main */ }
  }

  let owner = ""
  let repo = ""
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5_000, cwd, stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
    if (match) { owner = match[1]; repo = match[2] }
  } catch { /* ignore */ }

  return { defaultBranch, owner, repo, pm }
}

export function buildConfig(cwd: string, basic: { defaultBranch: string; owner: string; repo: string; pm: string }): Record<string, unknown> {
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8")) } catch { return {} } })()
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  const find = (...c: string[]) => { for (const s of c) { if (scripts[s]) return `${basic.pm} ${s}` } return "" }

  const config: Record<string, unknown> = {
    "$schema": "https://raw.githubusercontent.com/aharonyaircohen/Kody-Engine-Lite/main/kody.config.schema.json",
    quality: {
      typecheck: find("typecheck", "type-check") || (pkg.devDependencies?.typescript ? `${basic.pm} tsc --noEmit` : ""),
      lint: find("lint"),
      lintFix: find("lint:fix", "lint-fix"),
      formatFix: find("format", "format:fix"),
      testUnit: find("test:unit", "test", "test:ci"),
    },
    git: { defaultBranch: basic.defaultBranch },
    github: { owner: basic.owner, repo: basic.repo },
    agent: {
      provider: "anthropic",
      modelMap: { cheap: "haiku", mid: "sonnet", strong: "opus" },
    },
  }

  const mcp = detectMcpConfig(cwd, basic.pm, pkg)
  if (mcp) config.mcp = mcp

  return config
}

function detectMcpConfig(
  cwd: string,
  pm: string,
  pkg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const allDeps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) }
  const hasFrontend = FRONTEND_DEPS.some((dep) => dep in allDeps)
  if (!hasFrontend) return undefined

  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  const hasDevScript = !!scripts.dev

  const isNext = "next" in allDeps || "nuxt" in allDeps
  const isVite = "vite" in allDeps
  const defaultPort = isNext ? 3000 : isVite ? 5173 : 3000

  const mcp: Record<string, unknown> = {
    enabled: true,
    servers: {},
    stages: ["build", "review"],
  }

  if (hasDevScript) {
    mcp.devServer = {
      command: `${pm} dev`,
      url: `http://localhost:${defaultPort}`,
    }
  }

  return mcp
}
