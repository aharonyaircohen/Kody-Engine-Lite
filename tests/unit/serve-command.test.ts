import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

/**
 * Tests for `kody serve` command.
 *
 * Tests the decision logic, arg parsing, environment setup,
 * context file generation, and launch configuration.
 */

// ─── Arg parsing (pure logic, extracted from serve.ts pattern) ──────────────

describe("serve arg parsing", () => {
  function parseServeArgs(args: string[]): {
    cwd?: string
    provider?: string
    model?: string
    noClaude: boolean
    vscode: boolean
  } {
    function getArg(a: string[], flag: string): string | undefined {
      for (const item of a) {
        if (item.startsWith(`${flag}=`)) return item.slice(flag.length + 1)
      }
      const idx = a.indexOf(flag)
      if (idx !== -1 && a[idx + 1] && !a[idx + 1].startsWith("--")) {
        return a[idx + 1]
      }
      return undefined
    }

    return {
      cwd: getArg(args, "--cwd"),
      provider: getArg(args, "--provider"),
      model: getArg(args, "--model"),
      noClaude: args.includes("--no-claude"),
      vscode: args.includes("--vscode"),
    }
  }

  it("parses empty args", () => {
    const opts = parseServeArgs([])
    expect(opts.cwd).toBeUndefined()
    expect(opts.provider).toBeUndefined()
    expect(opts.model).toBeUndefined()
    expect(opts.noClaude).toBe(false)
    expect(opts.vscode).toBe(false)
  })

  it("parses --cwd", () => {
    const opts = parseServeArgs(["--cwd", "/tmp/project"])
    expect(opts.cwd).toBe("/tmp/project")
  })

  it("parses --cwd= style", () => {
    const opts = parseServeArgs(["--cwd=/tmp/project"])
    expect(opts.cwd).toBe("/tmp/project")
  })

  it("parses --provider and --model", () => {
    const opts = parseServeArgs(["--provider", "minimax", "--model", "MiniMax-M1"])
    expect(opts.provider).toBe("minimax")
    expect(opts.model).toBe("MiniMax-M1")
  })

  it("parses --no-claude flag", () => {
    const opts = parseServeArgs(["--no-claude"])
    expect(opts.noClaude).toBe(true)
  })

  it("parses --vscode flag", () => {
    const opts = parseServeArgs(["--vscode"])
    expect(opts.vscode).toBe(true)
  })

  it("parses all flags together", () => {
    const opts = parseServeArgs([
      "--cwd", "/tmp/project",
      "--provider", "openai",
      "--model", "gpt-4o",
      "--vscode",
    ])
    expect(opts.cwd).toBe("/tmp/project")
    expect(opts.provider).toBe("openai")
    expect(opts.model).toBe("gpt-4o")
    expect(opts.vscode).toBe(true)
  })
})

// ─── LiteLLM proxy decision logic ──────────────────────────────────────────

describe("serve LiteLLM decision", () => {
  function decideLitellmAction(
    needsProxy: boolean,
    proxyRunning: boolean,
  ): "skip" | "already-running" | "start" {
    if (!needsProxy) return "skip"
    if (proxyRunning) return "already-running"
    return "start"
  }

  it("skips when using Anthropic directly (no proxy needed)", () => {
    expect(decideLitellmAction(false, false)).toBe("skip")
  })

  it("reuses when proxy already running", () => {
    expect(decideLitellmAction(true, true)).toBe("already-running")
  })

  it("starts proxy when needed and not running", () => {
    expect(decideLitellmAction(true, false)).toBe("start")
  })
})

// ─── Claude Code env setup ─────────────────────────────────────────────────

describe("serve Claude Code environment", () => {
  function buildClaudeEnv(
    usesProxy: boolean,
    litellmUrl: string,
    existingApiKey?: string,
  ): Record<string, string> {
    const env: Record<string, string> = {}

    if (usesProxy) {
      env.ANTHROPIC_BASE_URL = litellmUrl
      env.ANTHROPIC_API_KEY = existingApiKey || `sk-ant-api03-${"0".repeat(64)}`
    }

    return env
  }

  it("sets ANTHROPIC_BASE_URL when using proxy", () => {
    const env = buildClaudeEnv(true, "http://localhost:4000")
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:4000")
  })

  it("sets dummy ANTHROPIC_API_KEY when using proxy without real key", () => {
    const env = buildClaudeEnv(true, "http://localhost:4000")
    expect(env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-api03-0+$/)
  })

  it("preserves real ANTHROPIC_API_KEY when available", () => {
    const env = buildClaudeEnv(true, "http://localhost:4000", "sk-real-key")
    expect(env.ANTHROPIC_API_KEY).toBe("sk-real-key")
  })

  it("sets no extra env vars when not using proxy (safe for standalone VS Code)", () => {
    const env = buildClaudeEnv(false, "http://localhost:4000")
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})

// ─── Model resolution for serve ────────────────────────────────────────────

describe("serve model resolution", () => {
  function resolveServeModel(config: {
    default?: { model: string }
    modelMap: Record<string, string>
  }): string | undefined {
    return config.default?.model
      ?? config.modelMap.mid
      ?? config.modelMap.cheap
      ?? Object.values(config.modelMap)[0]
  }

  it("uses default model when set", () => {
    const model = resolveServeModel({
      default: { model: "MiniMax-M1" },
      modelMap: { cheap: "old-model" },
    })
    expect(model).toBe("MiniMax-M1")
  })

  it("falls back to mid tier", () => {
    const model = resolveServeModel({
      modelMap: { cheap: "cheap-model", mid: "mid-model" },
    })
    expect(model).toBe("mid-model")
  })

  it("falls back to cheap tier when no mid", () => {
    const model = resolveServeModel({
      modelMap: { cheap: "cheap-model" },
    })
    expect(model).toBe("cheap-model")
  })

  it("falls back to first available model", () => {
    const model = resolveServeModel({
      modelMap: { premium: "premium-model" },
    })
    expect(model).toBe("premium-model")
  })

  it("returns undefined when no models configured", () => {
    const model = resolveServeModel({ modelMap: {} })
    expect(model).toBeUndefined()
  })
})

// ─── CLI dispatch ──────────────────────────────────────────────────────────

describe("serve CLI dispatch", () => {
  it("serve command is registered in CLI", async () => {
    const mod = await import("../../src/bin/commands/serve.js")
    expect(typeof mod.serveCommand).toBe("function")
  })
})

// ─── Cleanup behavior ──────────────────────────────────────────────────────

describe("serve cleanup", () => {
  it("cleanup function handles null processes gracefully", () => {
    let litellmProcess: { killed: boolean; kill: (sig: string) => void } | null = null
    let devServerHandle: { stop: () => void } | null = null
    let claudeProcess: { killed: boolean; kill: (sig: string) => void } | null = null

    const cleanup = () => {
      if (claudeProcess && !claudeProcess.killed) {
        claudeProcess.kill("SIGTERM")
      }
      if (devServerHandle) {
        devServerHandle.stop()
      }
      if (litellmProcess) {
        litellmProcess.kill("SIGTERM")
      }
    }

    expect(() => cleanup()).not.toThrow()
  })

  it("cleanup kills all processes", () => {
    const kills: string[] = []

    const litellmProcess = { killed: false, kill: (sig: string) => kills.push(`litellm:${sig}`) }
    const devServerHandle = { stop: () => kills.push("devserver:stop") }
    const claudeProcess = { killed: false, kill: (sig: string) => kills.push(`claude:${sig}`) }

    const cleanup = () => {
      if (claudeProcess && !claudeProcess.killed) {
        claudeProcess.kill("SIGTERM")
      }
      if (devServerHandle) {
        devServerHandle.stop()
      }
      if (litellmProcess) {
        litellmProcess.kill("SIGTERM")
      }
    }

    cleanup()

    expect(kills).toContain("claude:SIGTERM")
    expect(kills).toContain("devserver:stop")
    expect(kills).toContain("litellm:SIGTERM")
  })

  it("cleanup skips already-killed claude process", () => {
    const kills: string[] = []

    const claudeProcess = { killed: true, kill: (sig: string) => kills.push(`claude:${sig}`) }

    const cleanup = () => {
      if (claudeProcess && !claudeProcess.killed) {
        claudeProcess.kill("SIGTERM")
      }
    }

    cleanup()

    expect(kills).not.toContain("claude:SIGTERM")
  })
})

// ─── Context file (.claude/kody-context.md) ────────────────────────────────

describe("serve context file", () => {
  it("buildKodyContextContent includes memory and learning instructions", async () => {
    const { buildKodyContextContent } = await import("../../src/bin/commands/serve.js")
    const memory = "# Project Memory\n\n## architecture\n- Framework: Next.js 14"
    const content = buildKodyContextContent(memory, "/tmp/project")

    expect(content).toContain("Next.js 14")
    expect(content).toContain("Kody Memory System")
    expect(content).toContain(".kody/memory")
    expect(content).toContain("Do NOT proactively write")
    expect(content).toContain("only when the user explicitly asks")
  })

  it("buildKodyContextContent works with empty memory", async () => {
    const { buildKodyContextContent } = await import("../../src/bin/commands/serve.js")
    const content = buildKodyContextContent("", "/tmp/project")

    expect(content).toContain("Kody Memory System")
    expect(content).not.toContain("Project Memory")
  })

  it("writeKodyContext creates .claude/ directory and writes file", async () => {
    const { writeKodyContext } = await import("../../src/bin/commands/serve.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-ctx-"))
    const content = "# Test Context\n\nSome memory content"

    const filePath = writeKodyContext(tmpDir, content)

    expect(filePath).toBe(path.join(tmpDir, ".claude", "kody-context.md"))
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toBe(content)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it("writeKodyContext overwrites existing file", async () => {
    const { writeKodyContext } = await import("../../src/bin/commands/serve.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-ctx-"))
    const claudeDir = path.join(tmpDir, ".claude")
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, "kody-context.md"), "old content")

    writeKodyContext(tmpDir, "new content")

    expect(fs.readFileSync(path.join(claudeDir, "kody-context.md"), "utf-8")).toBe("new content")

    fs.rmSync(tmpDir, { recursive: true })
  })

  it("writeKodyContext preserves other .claude/ files", async () => {
    const { writeKodyContext } = await import("../../src/bin/commands/serve.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-ctx-"))
    const claudeDir = path.join(tmpDir, ".claude")
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, "settings.local.json"), '{"existing": true}')

    writeKodyContext(tmpDir, "kody memory")

    // Other files untouched
    expect(fs.readFileSync(path.join(claudeDir, "settings.local.json"), "utf-8")).toBe('{"existing": true}')
    // Kody context written
    expect(fs.readFileSync(path.join(claudeDir, "kody-context.md"), "utf-8")).toBe("kody memory")

    fs.rmSync(tmpDir, { recursive: true })
  })
})

// ─── Memory read ───────────────────────────────────────────────────────────

describe("serve memory read", () => {
  it("readProjectMemory returns content from .kody/memory/ files", async () => {
    const { readProjectMemory } = await import("../../src/memory.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-test-"))
    const memDir = path.join(tmpDir, ".kody", "memory")
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, "architecture.md"), "- Framework: Next.js 14\n- Language: TypeScript")
    fs.writeFileSync(path.join(memDir, "conventions.md"), "- Use vitest for testing\n- Prefer pnpm")

    const memory = readProjectMemory(tmpDir)

    expect(memory).toContain("Project Memory")
    expect(memory).toContain("Next.js 14")
    expect(memory).toContain("vitest")

    fs.rmSync(tmpDir, { recursive: true })
  })

  it("readProjectMemory returns empty string when no memory dir", async () => {
    const { readProjectMemory } = await import("../../src/memory.js")
    const os = await import("os")
    const fs = await import("fs")
    const path = await import("path")

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-serve-test-"))
    const memory = readProjectMemory(tmpDir)

    expect(memory).toBe("")

    fs.rmSync(tmpDir, { recursive: true })
  })
})

// ─── LiteLLM alias generation ──────────────────────────────────────────────

describe("serve LiteLLM aliases", () => {
  it("augments config with Claude model aliases", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")

    const baseConfig = [
      "model_list:",
      "  - model_name: MiniMax-M2.7-highspeed",
      "    litellm_params:",
      "      model: minimax/MiniMax-M2.7-highspeed",
      "      api_key: os.environ/MINIMAX_API_KEY",
      "",
      "litellm_settings:",
      "  drop_params: true",
      "",
    ].join("\n")

    const result = augmentConfigWithAliases(baseConfig, "minimax", "MiniMax-M2.7-highspeed")

    // Original model preserved
    expect(result).toContain("model_name: MiniMax-M2.7-highspeed")
    // Claude aliases added
    expect(result).toContain("model_name: claude-sonnet-4-6")
    expect(result).toContain("model_name: claude-opus-4-6")
    expect(result).toContain("model_name: claude-haiku-4-5")
    // All aliases route to the same provider model
    expect(result).toContain("model: minimax/MiniMax-M2.7-highspeed")
    // Settings block preserved
    expect(result).toContain("litellm_settings:")
    expect(result).toContain("drop_params: true")
  })

  it("generates config from scratch when no base config", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")

    const result = augmentConfigWithAliases(undefined, "openai", "gpt-4o")

    expect(result).toContain("model_name: gpt-4o")
    expect(result).toContain("model_name: claude-sonnet-4-6")
    expect(result).toContain("model: openai/gpt-4o")
    expect(result).toContain("OPENAI_API_KEY")
  })

  it("does not duplicate target model in aliases", async () => {
    const { augmentConfigWithAliases } = await import("../../src/bin/commands/serve.js")

    const result = augmentConfigWithAliases(undefined, "anthropic", "claude-sonnet-4-6")

    // Should not have duplicate entries for claude-sonnet-4-6
    const matches = result.match(/model_name: claude-sonnet-4-6/g)
    expect(matches?.length).toBe(1)
  })
})

// ─── anyStageNeedsProxy integration ────────────────────────────────────────

describe("serve proxy detection via config", () => {
  it("detects proxy needed for minimax provider", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    const config = {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: {
        modelMap: { cheap: "MiniMax-M1" },
        provider: "minimax",
        default: { provider: "minimax", model: "MiniMax-M1" },
      },
    } as any

    expect(anyStageNeedsProxy(config)).toBe(true)
  })

  it("detects no proxy needed for anthropic provider", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    const config = {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: {
        modelMap: { cheap: "claude-sonnet-4-6" },
        default: { provider: "claude", model: "claude-sonnet-4-6" },
      },
    } as any

    expect(anyStageNeedsProxy(config)).toBe(false)
  })

  it("detects proxy needed for per-stage non-claude config", async () => {
    const { anyStageNeedsProxy } = await import("../../src/config.js")
    const config = {
      quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: {
        modelMap: {},
        stages: {
          build: { provider: "openai", model: "gpt-4o" },
          review: { provider: "claude", model: "claude-sonnet-4-6" },
        },
      },
    } as any

    expect(anyStageNeedsProxy(config)).toBe(true)
  })
})
