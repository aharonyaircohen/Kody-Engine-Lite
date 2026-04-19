import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { loadProfile, validateScriptReferences, ProfileError } from "../../../src-v2/profile.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody2-profile-"))
}

function writeProfile(dir: string, profile: unknown): string {
  const p = path.join(dir, "profile.json")
  fs.writeFileSync(p, JSON.stringify(profile, null, 2))
  return p
}

const VALID_MIN = {
  name: "mini",
  describe: "smallest valid profile",
  inputs: [{ name: "foo", flag: "--foo", type: "string", describe: "" }],
  claudeCode: {
    model: "inherit",
    permissionMode: "acceptEdits",
    maxTurns: null,
    systemPromptAppend: null,
    tools: ["Read"],
    hooks: { PreToolUse: [], PostToolUse: [], Stop: [] },
    skills: [],
    commands: [],
    subagents: [],
    plugins: [],
    mcpServers: [],
  },
  cliTools: [],
  scripts: { preflight: [{ script: "composePrompt" }], postflight: [] },
}

describe("profile: loadProfile", () => {
  it("loads a minimal valid profile", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, VALID_MIN)
    const profile = loadProfile(p)
    expect(profile.name).toBe("mini")
    expect(profile.dir).toBe(dir)
    expect(profile.scripts.preflight[0]!.script).toBe("composePrompt")
  })

  it("throws on missing file", () => {
    expect(() => loadProfile("/tmp/nope-" + Math.random() + "/profile.json")).toThrow(ProfileError)
  })

  it("throws on invalid JSON", () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "profile.json"), "{not json")
    expect(() => loadProfile(path.join(dir, "profile.json"))).toThrow(/invalid JSON/)
  })

  it("rejects missing name", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN } as Record<string, unknown>
    delete bad.name
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/"name" must be a non-empty string/)
  })

  it("rejects enum input without values", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN, inputs: [{ name: "x", flag: "--x", type: "enum", describe: "" }] }
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/requires non-empty "values"/)
  })

  it("rejects invalid permissionMode", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN, claudeCode: { ...VALID_MIN.claudeCode, permissionMode: "rogue" } }
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/permissionMode must be one of/)
  })

  it("rejects empty tools", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN, claudeCode: { ...VALID_MIN.claudeCode, tools: [] } }
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/tools must declare at least one/)
  })

  it("preserves runWhen on script entries", () => {
    const dir = tmpDir()
    const good = {
      ...VALID_MIN,
      scripts: {
        preflight: [{ script: "runFlow", runWhen: { "args.mode": "run" } }],
        postflight: [],
      },
    }
    const p = writeProfile(dir, good)
    const profile = loadProfile(p)
    expect(profile.scripts.preflight[0]!.runWhen).toEqual({ "args.mode": "run" })
  })
})

describe("profile: validateScriptReferences", () => {
  it("returns names not in the registry", () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, {
      ...VALID_MIN,
      scripts: {
        preflight: [{ script: "unknownScript" }, { script: "composePrompt" }],
        postflight: [{ script: "verify" }],
      },
    }))
    const missing = validateScriptReferences(profile, new Set(["composePrompt", "verify"]))
    expect(missing).toEqual(["unknownScript"])
  })

  it("returns empty when all scripts registered", () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, VALID_MIN))
    const missing = validateScriptReferences(profile, new Set(["composePrompt"]))
    expect(missing).toEqual([])
  })
})
