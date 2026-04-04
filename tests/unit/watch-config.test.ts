import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { parseWatchConfig } from "../../src/watch/index.js"

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-watch-config-"))
}

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify(config))
}

describe("parseWatchConfig", () => {
  let tmpDir: string
  const originalRepo = process.env.REPO
  const originalDigest = process.env.WATCH_DIGEST_ISSUE

  beforeEach(() => {
    tmpDir = createTmpDir()
    delete process.env.REPO
    delete process.env.WATCH_DIGEST_ISSUE
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalRepo !== undefined) process.env.REPO = originalRepo
    else delete process.env.REPO
    if (originalDigest !== undefined) process.env.WATCH_DIGEST_ISSUE = originalDigest
    else delete process.env.WATCH_DIGEST_ISSUE
  })

  it("reads watch.model from config", () => {
    writeConfig(tmpDir, {
      github: { owner: "test", repo: "repo" },
      watch: { model: "minimax/MiniMax-M2.7-highspeed" },
    })
    const result = parseWatchConfig(tmpDir)
    expect(result.watchModel).toBe("minimax/MiniMax-M2.7-highspeed")
  })

  it("reads watch.model even when REPO env var is set", () => {
    process.env.REPO = "env-owner/env-repo"
    writeConfig(tmpDir, {
      github: { owner: "config-owner", repo: "config-repo" },
      watch: { model: "minimax/MiniMax-M2.7-highspeed" },
      agent: { provider: "minimax" },
    })
    const result = parseWatchConfig(tmpDir)
    expect(result.watchModel).toBe("minimax/MiniMax-M2.7-highspeed")
    expect(result.agentProvider).toBe("minimax")
    // REPO env takes precedence over config for repo
    expect(result.repo).toBe("env-owner/env-repo")
  })

  it("reads agent.provider and agent.modelMap from config", () => {
    writeConfig(tmpDir, {
      github: { owner: "test", repo: "repo" },
      agent: {
        provider: "minimax",
        modelMap: { cheap: "minimax/cheap", mid: "minimax/mid" },
      },
    })
    const result = parseWatchConfig(tmpDir)
    expect(result.agentProvider).toBe("minimax")
    expect(result.agentModelMap).toEqual({ cheap: "minimax/cheap", mid: "minimax/mid" })
  })

  it("reads repo from config when REPO env is not set", () => {
    writeConfig(tmpDir, {
      github: { owner: "myorg", repo: "myrepo" },
    })
    const result = parseWatchConfig(tmpDir)
    expect(result.repo).toBe("myorg/myrepo")
  })

  it("prefers REPO env over config", () => {
    process.env.REPO = "env-owner/env-repo"
    writeConfig(tmpDir, {
      github: { owner: "config-owner", repo: "config-repo" },
    })
    const result = parseWatchConfig(tmpDir)
    expect(result.repo).toBe("env-owner/env-repo")
  })

  it("reads digestIssue from config", () => {
    writeConfig(tmpDir, {
      github: { owner: "test", repo: "repo" },
      watch: { digestIssue: 42 },
    })
    const result = parseWatchConfig(tmpDir)
    expect(result.digestIssue).toBe(42)
  })

  it("WATCH_DIGEST_ISSUE env overrides config digestIssue", () => {
    process.env.WATCH_DIGEST_ISSUE = "99"
    writeConfig(tmpDir, {
      github: { owner: "test", repo: "repo" },
      watch: { digestIssue: 42 },
    })
    const result = parseWatchConfig(tmpDir)
    expect(result.digestIssue).toBe(99)
  })

  it("returns empty repo when no config and no env", () => {
    const result = parseWatchConfig(tmpDir)
    expect(result.repo).toBe("")
  })

  it("handles missing config file gracefully", () => {
    const result = parseWatchConfig(tmpDir)
    expect(result.watchModel).toBeUndefined()
    expect(result.agentProvider).toBeUndefined()
  })

  it("handles invalid JSON gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "kody.config.json"), "not json")
    const result = parseWatchConfig(tmpDir)
    expect(result.watchModel).toBeUndefined()
  })
})
