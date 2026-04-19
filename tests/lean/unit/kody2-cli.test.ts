import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  parseKody2Args,
  unpackAllSecrets,
  resolveAuthToken,
  detectPackageManager,
} from "../../../src-v2/kody2-cli.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody2-cli-test-"))
}

describe("kody2-cli: parseKody2Args", () => {
  it("parses --issue", () => {
    const a = parseKody2Args(["--issue", "42"])
    expect(a.issueNumber).toBe(42)
    expect(a.errors).toEqual([])
  })

  it("requires --issue", () => {
    const a = parseKody2Args([])
    expect(a.errors.some((e) => e.includes("--issue"))).toBe(true)
  })

  it("rejects non-positive --issue", () => {
    expect(parseKody2Args(["--issue", "0"]).errors.length).toBeGreaterThan(0)
    expect(parseKody2Args(["--issue", "abc"]).errors.length).toBeGreaterThan(0)
  })

  it("parses --cwd + --skip-install + --skip-litellm + --verbose", () => {
    const a = parseKody2Args(["--issue", "1", "--cwd", "/tmp", "--skip-install", "--skip-litellm", "--verbose"])
    expect(a.cwd).toBe("/tmp")
    expect(a.skipInstall).toBe(true)
    expect(a.skipLitellm).toBe(true)
    expect(a.verbose).toBe(true)
  })

  it("parses --package-manager override", () => {
    const a = parseKody2Args(["--issue", "1", "--package-manager", "yarn"])
    expect(a.packageManager).toBe("yarn")
  })

  it("rejects invalid --package-manager", () => {
    const a = parseKody2Args(["--issue", "1", "--package-manager", "cargo"])
    expect(a.errors.some((e) => e.includes("--package-manager"))).toBe(true)
  })

  it("rejects unknown --flags", () => {
    const a = parseKody2Args(["--issue", "1", "--bogus"])
    expect(a.errors.some((e) => e.includes("--bogus"))).toBe(true)
  })
})

describe("kody2-cli: unpackAllSecrets", () => {
  it("returns 0 when ALL_SECRETS missing", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(unpackAllSecrets(env)).toBe(0)
  })

  it("unpacks JSON into env vars", () => {
    const env: NodeJS.ProcessEnv = {
      ALL_SECRETS: JSON.stringify({ MINIMAX_API_KEY: "m123", ANTHROPIC_API_KEY: "a456" }),
    }
    const n = unpackAllSecrets(env)
    expect(n).toBe(2)
    expect(env.MINIMAX_API_KEY).toBe("m123")
    expect(env.ANTHROPIC_API_KEY).toBe("a456")
  })

  it("does not override already-set env vars", () => {
    const env: NodeJS.ProcessEnv = {
      MINIMAX_API_KEY: "preexisting",
      ALL_SECRETS: JSON.stringify({ MINIMAX_API_KEY: "from-secrets", NEW_KEY: "new" }),
    }
    const n = unpackAllSecrets(env)
    expect(n).toBe(1)
    expect(env.MINIMAX_API_KEY).toBe("preexisting")
    expect(env.NEW_KEY).toBe("new")
  })

  it("returns 0 on malformed JSON", () => {
    const env: NodeJS.ProcessEnv = { ALL_SECRETS: "{not-json" }
    expect(unpackAllSecrets(env)).toBe(0)
  })

  it("skips non-string values", () => {
    const env: NodeJS.ProcessEnv = {
      ALL_SECRETS: JSON.stringify({ A: "str", B: 123, C: null, D: true }),
    }
    const n = unpackAllSecrets(env)
    expect(n).toBe(1)
    expect(env.A).toBe("str")
    expect(env.B).toBeUndefined()
  })

  it("skips empty strings", () => {
    const env: NodeJS.ProcessEnv = { ALL_SECRETS: JSON.stringify({ X: "", Y: "v" }) }
    expect(unpackAllSecrets(env)).toBe(1)
    expect(env.X).toBeUndefined()
    expect(env.Y).toBe("v")
  })
})

describe("kody2-cli: resolveAuthToken", () => {
  it("picks KODY_TOKEN first", () => {
    const env: NodeJS.ProcessEnv = { KODY_TOKEN: "k", GH_TOKEN: "g", GITHUB_TOKEN: "gh", GH_PAT: "p" }
    expect(resolveAuthToken(env)).toBe("k")
    expect(env.GH_TOKEN).toBe("g")
  })

  it("falls back to GH_TOKEN", () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "g" }
    expect(resolveAuthToken(env)).toBe("g")
    expect(env.GH_TOKEN).toBe("g")
  })

  it("falls back to GITHUB_TOKEN and copies into GH_TOKEN", () => {
    const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: "gh" }
    expect(resolveAuthToken(env)).toBe("gh")
    expect(env.GH_TOKEN).toBe("gh")
  })

  it("falls back to GH_PAT", () => {
    const env: NodeJS.ProcessEnv = { GH_PAT: "p" }
    expect(resolveAuthToken(env)).toBe("p")
    expect(env.GH_TOKEN).toBe("p")
  })

  it("returns undefined when none set", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(resolveAuthToken(env)).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
  })
})

describe("kody2-cli: detectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfile: 1")
    expect(detectPackageManager(d)).toBe("pnpm")
  })

  it("detects yarn from yarn.lock", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "yarn.lock"), "")
    expect(detectPackageManager(d)).toBe("yarn")
  })

  it("detects bun from bun.lockb", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "bun.lockb"), "")
    expect(detectPackageManager(d)).toBe("bun")
  })

  it("defaults to npm when no lockfile", () => {
    const d = tmpDir()
    expect(detectPackageManager(d)).toBe("npm")
  })

  it("prefers pnpm over yarn when both lockfiles exist", () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "")
    fs.writeFileSync(path.join(d, "yarn.lock"), "")
    expect(detectPackageManager(d)).toBe("pnpm")
  })
})
