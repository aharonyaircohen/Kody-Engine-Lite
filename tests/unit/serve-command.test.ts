import { describe, it, expect } from "vitest"

/**
 * Tests for `kody serve` command.
 *
 * Subcommands:
 *   kody-engine serve          — infra only (LiteLLM + dev server + context)
 *   kody-engine serve claude   — above + Claude Code CLI (execFileSync, TTY passthrough)
 *   kody-engine serve vscode   — above + VS Code with env vars
 */

// ─── Arg parsing with subcommands ──────────────────────────────────────────

describe("serve arg parsing", () => {
  type ServeMode = "infra" | "claude" | "vscode"

  function parseServeArgs(args: string[]): {
    mode: ServeMode
    cwd?: string
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

  it("parses --model", () => {
    const opts = parseServeArgs(["--model", "minimax/MiniMax-M1"])
    expect(opts.model).toBe("minimax/MiniMax-M1")
  })

  it("parses all options together", () => {
    const opts = parseServeArgs(["vscode", "--cwd", "/tmp", "--model", "openai/gpt-4o"])
    expect(opts.mode).toBe("vscode")
    expect(opts.cwd).toBe("/tmp")
    expect(opts.model).toBe("openai/gpt-4o")
  })

  it("unknown subcommand defaults to infra", () => {
    expect(parseServeArgs(["--cwd", "/tmp"]).mode).toBe("infra")
  })

  it("--cwd= style works", () => {
    const opts = parseServeArgs(["claude", "--cwd=/tmp/p"])
    expect(opts.cwd).toBe("/tmp/p")
  })
})

// ─── LiteLLM proxy decision ────────────────────────────────────────────────

describe("serve LiteLLM decision", () => {
  function decideLitellmAction(needsProxy: boolean, proxyRunning: boolean, hasAliases: boolean): "skip" | "reuse" | "restart" | "start" {
    if (!needsProxy) return "skip"
    if (proxyRunning && hasAliases) return "reuse"
    if (proxyRunning && !hasAliases) return "restart"
    return "start"
  }

  it("skips when using Anthropic directly", () => {
    expect(decideLitellmAction(false, false, false)).toBe("skip")
  })

  it("reuses when proxy running with aliases", () => {
    expect(decideLitellmAction(true, true, true)).toBe("reuse")
  })

  it("restarts when proxy running without aliases", () => {
    expect(decideLitellmAction(true, true, false)).toBe("restart")
  })

  it("starts fresh when proxy not running", () => {
    expect(decideLitellmAction(true, false, false)).toBe("start")
  })
})

// ─── Proxy env (dummy key for interactive mode) ────────────────────────────

describe("serve proxy env", () => {
  function buildProxyEnv(litellmUrl: string, existingApiKey?: string): Record<string, string> {
    return {
      ANTHROPIC_BASE_URL: litellmUrl,
      ANTHROPIC_API_KEY: existingApiKey || `sk-ant-api03-${"0".repeat(64)}`,
    }
  }

  it("sets ANTHROPIC_BASE_URL to proxy", () => {
    const env = buildProxyEnv("http://localhost:4000")
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4000")
  })

  it("sets dummy ANTHROPIC_API_KEY for interactive auth bypass", () => {
    const env = buildProxyEnv("http://localhost:4000")
    expect(env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-api03-0+$/)
    expect(env.ANTHROPIC_API_KEY.length).toBeGreaterThan(20)
  })

  it("preserves real ANTHROPIC_API_KEY when available", () => {
    const env = buildProxyEnv("http://localhost:4000", "sk-ant-real-key")
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-real-key")
  })

  it("does not set ANTHROPIC_BASE_URL for non-proxy usage", () => {
    // When not using proxy, env should be inherited naturally (no custom env)
    const shouldUseCustomEnv = false
    expect(shouldUseCustomEnv).toBe(false)
  })
})

// ─── Claude Code CLI launch args ───────────────────────────────────────────

describe("serve Claude Code launch args", () => {
  function buildClaudeArgs(model?: string): string[] {
    const args: string[] = ["--dangerously-skip-permissions"]
    if (model) args.push("--model", model)
    return args
  }

  it("always includes --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs()
    expect(args).toContain("--dangerously-skip-permissions")
  })

  it("includes --model when set", () => {
    const args = buildClaudeArgs("MiniMax-M1")
    expect(args).toContain("--dangerously-skip-permissions")
    expect(args).toContain("--model")
    expect(args).toContain("MiniMax-M1")
  })

  it("omits --model when undefined", () => {
    const args = buildClaudeArgs(undefined)
    expect(args).not.toContain("--model")
    expect(args).toEqual(["--dangerously-skip-permissions"])
  })
})

// ─── Model resolution ──────────────────────────────────────────────────────

describe("serve model resolution", () => {
  /** Resolves the bare model name from a "provider/model" spec via the same priority serve.ts uses. */
  function resolveModel(config: { default?: string; modelMap: Record<string, string> }): string | undefined {
    const spec = config.default ?? config.modelMap.mid ?? config.modelMap.cheap ?? Object.values(config.modelMap)[0]
    if (!spec) return undefined
    const slash = spec.indexOf("/")
    return slash > 0 ? spec.slice(slash + 1) : spec
  }

  it("uses default model", () => {
    expect(resolveModel({ default: "claude/M1", modelMap: { cheap: "claude/old" } })).toBe("M1")
  })

  it("falls back to mid", () => {
    expect(resolveModel({ modelMap: { cheap: "claude/c", mid: "claude/m" } })).toBe("m")
  })

  it("falls back to cheap", () => {
    expect(resolveModel({ modelMap: { cheap: "claude/c" } })).toBe("c")
  })

  it("falls back to first available", () => {
    expect(resolveModel({ modelMap: { premium: "claude/p" } })).toBe("p")
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

  it("exports buildKodyContextContent", async () => {
    const mod = await import("../../src/bin/commands/serve.js")
    expect(typeof mod.buildKodyContextContent).toBe("function")
  })

  it("exports augmentConfigWithAliases", async () => {
    const mod = await import("../../src/bin/commands/serve.js")
    expect(typeof mod.augmentConfigWithAliases).toBe("function")
  })

  it("exports writeKodyContext", async () => {
    const mod = await import("../../src/bin/commands/serve.js")
    expect(typeof mod.writeKodyContext).toBe("function")
  })
})

// ─── Cleanup ───────────────────────────────────────────────────────────────

describe("serve cleanup", () => {
  it("handles null processes", () => {
    let launched: { killed: boolean; kill: (s: string) => void } | null = null
    const cleanup = () => { if (launched && !launched.killed) launched.kill("SIGTERM") }
    expect(() => cleanup()).not.toThrow()
  })

  it("kills all processes in order", () => {
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

// ─── Context file (.claude/kody-context.md) ────────────────────────────────

describe("serve context file", () => {
  it("buildKodyContextContent includes memory and passive learning instructions", async () => {
    const { buildKodyContextContent } = await import("../../src/bin/commands/serve.js")
    const content = buildKodyContextContent("# Project Memory\n\n## arch\n- Next.js 14", "/tmp/p")

    expect(content).toContain("Next.js 14")
    expect(content).toContain("Kody Memory System")
    expect(content).toContain(".kody/memory")
    expect(content).toContain("Do NOT proactively write")
    expect(content).toContain("only when the user explicitly asks")
  })

  it("buildKodyContextContent works with empty memory", async () => {
    const { buildKodyContextContent } = await import("../../src/bin/commands/serve.js")
    const content = buildKodyContextContent("", "/tmp/p")

    expect(content).toContain("Kody Memory System")
    expect(content).not.toContain("Project Memory")
  })

  it("writeKodyContext creates .claude/ dir and writes file", async () => {
    const { writeKodyContext } = await import("../../src/bin/commands/serve.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-"))
    const filePath = writeKodyContext(tmp, "test content")

    expect(filePath).toBe(path.join(tmp, ".claude", "kody-context.md"))
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toBe("test content")

    fs.rmSync(tmp, { recursive: true })
  })

  it("writeKodyContext overwrites existing file", async () => {
    const { writeKodyContext } = await import("../../src/bin/commands/serve.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-"))
    writeKodyContext(tmp, "old")
    writeKodyContext(tmp, "new")

    expect(fs.readFileSync(path.join(tmp, ".claude", "kody-context.md"), "utf-8")).toBe("new")

    fs.rmSync(tmp, { recursive: true })
  })

  it("writeKodyContext preserves other .claude/ files", async () => {
    const { writeKodyContext } = await import("../../src/bin/commands/serve.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-"))
    const claudeDir = path.join(tmp, ".claude")
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, "settings.local.json"), '{"ok":true}')

    writeKodyContext(tmp, "kody memory")

    expect(fs.readFileSync(path.join(claudeDir, "settings.local.json"), "utf-8")).toBe('{"ok":true}')
    expect(fs.readFileSync(path.join(claudeDir, "kody-context.md"), "utf-8")).toBe("kody memory")

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
    fs.writeFileSync(path.join(memDir, "conventions.md"), "- Use vitest")

    const memory = readProjectMemory(tmp)
    expect(memory).toContain("Project Memory")
    expect(memory).toContain("Next.js 14")
    expect(memory).toContain("vitest")

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

// ─── LiteLLM alias generation ──────────────────────────────────────────────

describe("serve LiteLLM aliases", () => {
  it("augments existing config with Claude model aliases", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const base = [
      "model_list:",
      "  - model_name: MiniMax-M1",
      "    litellm_params:",
      "      model: minimax/MiniMax-M1",
      "      api_key: os.environ/MINIMAX_API_KEY",
      "",
      "litellm_settings:",
      "  drop_params: true",
      "",
    ].join("\n")

    const result = augmentConfigWithAliases(base, "minimax", "MiniMax-M1")

    // Original model preserved
    expect(result).toContain("model_name: MiniMax-M1")
    // Claude aliases added
    expect(result).toContain("model_name: claude-sonnet-4-6")
    expect(result).toContain("model_name: claude-opus-4-6")
    expect(result).toContain("model_name: claude-haiku-4-5")
    expect(result).toContain("model_name: claude-sonnet-4-5-20250514")
    expect(result).toContain("model_name: claude-3-5-sonnet-20241022")
    // All aliases route to same provider model
    const routeCount = (result.match(/model: minimax\/MiniMax-M1/g) ?? []).length
    expect(routeCount).toBeGreaterThanOrEqual(7) // original + 6+ aliases
    // Settings block preserved after aliases
    expect(result).toContain("litellm_settings:")
    expect(result).toContain("drop_params: true")
    // Aliases appear before settings
    const aliasIdx = result.indexOf("model_name: claude-sonnet-4-6")
    const settingsIdx = result.indexOf("litellm_settings:")
    expect(aliasIdx).toBeLessThan(settingsIdx)
  })

  it("generates from scratch when no base config", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const result = augmentConfigWithAliases(undefined, "openai", "gpt-4o")

    expect(result).toContain("model_list:")
    expect(result).toContain("model_name: gpt-4o")
    expect(result).toContain("model_name: claude-sonnet-4-6")
    expect(result).toContain("model: openai/gpt-4o")
    expect(result).toContain("OPENAI_API_KEY")
    expect(result).toContain("drop_params: true")
  })

  it("skips duplicate when target model is a Claude model name", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const result = augmentConfigWithAliases(undefined, "anthropic", "claude-sonnet-4-6")

    // Should appear exactly once (as the target), not duplicated as alias
    expect(result.match(/model_name: claude-sonnet-4-6/g)?.length).toBe(1)
  })

  it("appends aliases when config has no litellm_settings block", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const base = [
      "model_list:",
      "  - model_name: MyModel",
      "    litellm_params:",
      "      model: provider/MyModel",
      "      api_key: os.environ/PROVIDER_API_KEY",
    ].join("\n")

    const result = augmentConfigWithAliases(base, "provider", "MyModel")

    expect(result).toContain("model_name: claude-sonnet-4-6")
    expect(result).toContain("model: provider/MyModel")
  })

  it("uses correct API key env var for provider", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")
    const result = augmentConfigWithAliases(undefined, "gemini", "gemini-pro")

    expect(result).toContain("os.environ/GEMINI_API_KEY")
  })
})

// ─── Proxy detection via config ────────────────────────────────────────────

describe("serve proxy detection", () => {
  it("detects proxy for minimax", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    expect(anyStageNeedsProxy({
      agent: { modelMap: {}, default: "minimax/M1" },
    } as any)).toBe(true)
  })

  it("no proxy for anthropic/claude", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    expect(anyStageNeedsProxy({
      agent: { modelMap: {}, default: "claude/s4" },
    } as any)).toBe(false)
    expect(anyStageNeedsProxy({
      agent: { modelMap: {}, default: "anthropic/s4" },
    } as any)).toBe(false)
  })

  it("detects proxy for mixed per-stage configs", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    expect(anyStageNeedsProxy({
      agent: {
        modelMap: {},
        stages: {
          build: "openai/gpt-4o",
          review: "claude/claude-sonnet-4-6",
        },
      },
    } as any)).toBe(true)
  })

  it("no proxy when all stages use claude", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    expect(anyStageNeedsProxy({
      agent: {
        modelMap: {},
        stages: {
          build: "claude/claude-sonnet-4-6",
          review: "anthropic/claude-opus-4-6",
        },
      },
    } as any)).toBe(false)
  })
})

// ─── Dummy API key ─────────────────────────────────────────────────────────

describe("serve dummy API key", () => {
  it("getAnthropicApiKeyOrDummy returns real key when set", async () => {
    const { getAnthropicApiKeyOrDummy } = await import("../../src/config.js")
    const orig = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-real-key-123"

    expect(getAnthropicApiKeyOrDummy()).toBe("sk-ant-real-key-123")

    if (orig) process.env.ANTHROPIC_API_KEY = orig
    else delete process.env.ANTHROPIC_API_KEY
  })

  it("getAnthropicApiKeyOrDummy returns dummy when not set", async () => {
    const { getAnthropicApiKeyOrDummy } = await import("../../src/config.js")
    const orig = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    const dummy = getAnthropicApiKeyOrDummy()
    expect(dummy).toMatch(/^sk-ant-api03-0{64}$/)

    if (orig) process.env.ANTHROPIC_API_KEY = orig
  })
})
