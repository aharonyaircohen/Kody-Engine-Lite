import { describe, it, expect } from "vitest"

/**
 * Tests for `kody serve` command.
 *
 * Subcommands:
 *   kody-engine serve          — infra only (LiteLLM + dev server + context)
 *   kody-engine serve claude   — above + Claude Code CLI
 *   kody-engine serve vscode   — above + VS Code
 */

// ─── Arg parsing ───────────────────────────────────────────────────────────

describe("serve arg parsing", () => {
  type ServeMode = "infra" | "claude" | "vscode"

  function parseServeArgs(args: string[]): {
    mode: ServeMode
    cwd?: string
    provider?: string
    model?: string
  } {
    function getArg(a: string[], flag: string): string | undefined {
      for (const item of a) {
        if (item.startsWith(`${flag}=`)) return item.slice(flag.length + 1)
      }
      const idx = a.indexOf(flag)
      if (idx !== -1 && a[idx + 1] && !a[idx + 1].startsWith("--")) return a[idx + 1]
      return undefined
    }

    const sub = args[0]
    let mode: ServeMode = "infra"
    if (sub === "claude") mode = "claude"
    else if (sub === "vscode") mode = "vscode"

    return {
      mode,
      cwd: getArg(args, "--cwd"),
      provider: getArg(args, "--provider"),
      model: getArg(args, "--model"),
    }
  }

  it("defaults to infra mode with no subcommand", () => {
    expect(parseServeArgs([]).mode).toBe("infra")
  })

  it("parses 'claude' subcommand", () => {
    expect(parseServeArgs(["claude"]).mode).toBe("claude")
  })

  it("parses 'vscode' subcommand", () => {
    expect(parseServeArgs(["vscode"]).mode).toBe("vscode")
  })

  it("parses --cwd with subcommand", () => {
    const opts = parseServeArgs(["claude", "--cwd", "/tmp/project"])
    expect(opts.mode).toBe("claude")
    expect(opts.cwd).toBe("/tmp/project")
  })

  it("parses --provider and --model", () => {
    const opts = parseServeArgs(["--provider", "minimax", "--model", "MiniMax-M1"])
    expect(opts.provider).toBe("minimax")
    expect(opts.model).toBe("MiniMax-M1")
  })

  it("parses all options together", () => {
    const opts = parseServeArgs(["vscode", "--cwd", "/tmp", "--provider", "openai", "--model", "gpt-4o"])
    expect(opts.mode).toBe("vscode")
    expect(opts.cwd).toBe("/tmp")
    expect(opts.provider).toBe("openai")
    expect(opts.model).toBe("gpt-4o")
  })

  it("unknown subcommand defaults to infra", () => {
    expect(parseServeArgs(["--cwd", "/tmp"]).mode).toBe("infra")
  })
})

// ─── LiteLLM proxy decision ────────────────────────────────────────────────

describe("serve LiteLLM decision", () => {
  function decideLitellmAction(needsProxy: boolean, proxyRunning: boolean): "skip" | "already-running" | "start" {
    if (!needsProxy) return "skip"
    if (proxyRunning) return "already-running"
    return "start"
  }

  it("skips when using Anthropic directly", () => {
    expect(decideLitellmAction(false, false)).toBe("skip")
  })

  it("reuses when proxy already running", () => {
    expect(decideLitellmAction(true, true)).toBe("already-running")
  })

  it("starts proxy when needed and not running", () => {
    expect(decideLitellmAction(true, false)).toBe("start")
  })
})

// ─── Proxy env ─────────────────────────────────────────────────────────────

describe("serve proxy env", () => {
  function buildProxyEnv(litellmUrl: string, existingApiKey?: string): Record<string, string> {
    const env: Record<string, string> = {}
    env.ANTHROPIC_BASE_URL = litellmUrl
    env.ANTHROPIC_API_KEY = existingApiKey || `sk-ant-api03-${"0".repeat(64)}`
    return env
  }

  it("sets ANTHROPIC_BASE_URL", () => {
    const env = buildProxyEnv("http://localhost:4000")
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4000")
  })

  it("sets dummy ANTHROPIC_API_KEY when no real key", () => {
    const env = buildProxyEnv("http://localhost:4000")
    expect(env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-api03-0+$/)
  })

  it("preserves real ANTHROPIC_API_KEY", () => {
    const env = buildProxyEnv("http://localhost:4000", "sk-real")
    expect(env.ANTHROPIC_API_KEY).toBe("sk-real")
  })
})

// ─── Model resolution ──────────────────────────────────────────────────────

describe("serve model resolution", () => {
  function resolveModel(config: { default?: { model: string }; modelMap: Record<string, string> }): string | undefined {
    return config.default?.model ?? config.modelMap.mid ?? config.modelMap.cheap ?? Object.values(config.modelMap)[0]
  }

  it("uses default model", () => {
    expect(resolveModel({ default: { model: "M1" }, modelMap: { cheap: "old" } })).toBe("M1")
  })

  it("falls back to mid", () => {
    expect(resolveModel({ modelMap: { cheap: "c", mid: "m" } })).toBe("m")
  })

  it("falls back to cheap", () => {
    expect(resolveModel({ modelMap: { cheap: "c" } })).toBe("c")
  })

  it("falls back to first available", () => {
    expect(resolveModel({ modelMap: { premium: "p" } })).toBe("p")
  })

  it("returns undefined when empty", () => {
    expect(resolveModel({ modelMap: {} })).toBeUndefined()
  })
})

// ─── CLI dispatch ──────────────────────────────────────────────────────────

describe("serve CLI dispatch", () => {
  it("exports serveCommand", async () => {
    const mod = await import("../../src/bin/commands/serve.js")
    expect(typeof mod.serveCommand).toBe("function")
  })
})

// ─── Cleanup ───────────────────────────────────────────────────────────────

describe("serve cleanup", () => {
  it("handles null processes", () => {
    let launched: { killed: boolean; kill: (s: string) => void } | null = null
    const cleanup = () => { if (launched && !launched.killed) launched.kill("SIGTERM") }
    expect(() => cleanup()).not.toThrow()
  })

  it("kills all processes", () => {
    const kills: string[] = []
    const litellm = { kill: () => kills.push("litellm") }
    const dev = { stop: () => kills.push("dev") }
    const launched = { killed: false, kill: () => kills.push("launched") }

    const cleanup = () => {
      if (launched && !launched.killed) launched.kill()
      if (dev) dev.stop()
      if (litellm) litellm.kill()
    }

    cleanup()
    expect(kills).toEqual(["launched", "dev", "litellm"])
  })

  it("skips already-killed process", () => {
    const kills: string[] = []
    const launched = { killed: true, kill: () => kills.push("launched") }
    const cleanup = () => { if (launched && !launched.killed) launched.kill() }
    cleanup()
    expect(kills).toEqual([])
  })
})

// ─── Context file ──────────────────────────────────────────────────────────

describe("serve context file", () => {
  it("buildKodyContextContent includes memory and instructions", async () => {
    const { buildKodyContextContent } = await import("../../src/bin/commands/serve.js")
    const content = buildKodyContextContent("# Project Memory\n\n## arch\n- Next.js 14", "/tmp/p")

    expect(content).toContain("Next.js 14")
    expect(content).toContain("Kody Memory System")
    expect(content).toContain("Do NOT proactively write")
  })

  it("buildKodyContextContent works with empty memory", async () => {
    const { buildKodyContextContent } = await import("../../src/bin/commands/serve.js")
    const content = buildKodyContextContent("", "/tmp/p")

    expect(content).toContain("Kody Memory System")
    expect(content).not.toContain("Project Memory")
  })

  it("writeKodyContext creates file and preserves siblings", async () => {
    const { writeKodyContext } = await import("../../src/bin/commands/serve.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-"))
    const claudeDir = path.join(tmp, ".claude")
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, "settings.local.json"), '{"ok":true}')

    const filePath = writeKodyContext(tmp, "test content")

    expect(fs.readFileSync(filePath, "utf-8")).toBe("test content")
    expect(fs.readFileSync(path.join(claudeDir, "settings.local.json"), "utf-8")).toBe('{"ok":true}')

    fs.rmSync(tmp, { recursive: true })
  })
})

// ─── Memory read ───────────────────────────────────────────────────────────

describe("serve memory read", () => {
  it("reads .kody/memory/ files", async () => {
    const { readProjectMemory } = await import("../../src/memory.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-"))
    const memDir = path.join(tmp, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "arch.md"), "- Next.js 14")

    expect(readProjectMemory(tmp)).toContain("Next.js 14")
    fs.rmSync(tmp, { recursive: true })
  })

  it("returns empty when no memory dir", async () => {
    const { readProjectMemory } = await import("../../src/memory.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-"))
    expect(readProjectMemory(tmp)).toBe("")
    fs.rmSync(tmp, { recursive: true })
  })
})

// ─── LiteLLM aliases ──────────────────────────────────────────────────────

describe("serve LiteLLM aliases", () => {
  it("augments config with Claude model aliases", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const base = "model_list:\n  - model_name: MiniMax-M1\n    litellm_params:\n      model: minimax/MiniMax-M1\n      api_key: os.environ/MINIMAX_API_KEY\n\nlitellm_settings:\n  drop_params: true\n"

    const result = augmentConfigWithAliases(base, "minimax", "MiniMax-M1")

    expect(result).toContain("model_name: MiniMax-M1")
    expect(result).toContain("model_name: claude-sonnet-4-6")
    expect(result).toContain("model_name: claude-opus-4-6")
    expect(result).toContain("model: minimax/MiniMax-M1")
    expect(result).toContain("drop_params: true")
  })

  it("generates from scratch when no base config", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const result = augmentConfigWithAliases(undefined, "openai", "gpt-4o")

    expect(result).toContain("model_name: gpt-4o")
    expect(result).toContain("model_name: claude-sonnet-4-6")
    expect(result).toContain("model: openai/gpt-4o")
  })

  it("skips duplicate when target is a Claude model", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const result = augmentConfigWithAliases(undefined, "anthropic", "claude-sonnet-4-6")

    expect(result.match(/model_name: claude-sonnet-4-6/g)?.length).toBe(1)
  })
})

// ─── Proxy detection ───────────────────────────────────────────────────────

describe("serve proxy detection", () => {
  it("detects proxy for minimax", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    expect(anyStageNeedsProxy({ agent: { modelMap: {}, default: { provider: "minimax", model: "M1" } } } as any)).toBe(true)
  })

  it("no proxy for anthropic", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    expect(anyStageNeedsProxy({ agent: { modelMap: {}, default: { provider: "claude", model: "s4" } } } as any)).toBe(false)
  })

  it("detects proxy for mixed per-stage", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    const config = { agent: { modelMap: {}, stages: { build: { provider: "openai", model: "g4o" }, review: { provider: "claude", model: "s4" } } } } as any
    expect(anyStageNeedsProxy(config)).toBe(true)
  })
})
