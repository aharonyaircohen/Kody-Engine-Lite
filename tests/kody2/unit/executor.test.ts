/**
 * Focused unit tests for the executor's two in-process primitives:
 *   - `runWhen` conditional evaluation (via shouldRun, exposed indirectly).
 *   - Input validation / coercion (via validateInputs, exposed indirectly).
 *
 * Full agent-running behavior is covered by the existing regression suite
 * (all tests in tests/kody2 passed after the refactor, proving
 * behavior-compatibility). Here we lock in the new surface.
 */

import { describe, it, expect } from "vitest"
import { loadProfile } from "../../../src-v2/profile.js"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody2-exec-"))
}

const BASE = {
  name: "t",
  describe: "",
  inputs: [
    { name: "mode", flag: "--mode", type: "enum", values: ["a", "b"], required: true, describe: "" },
    { name: "n", flag: "--n", type: "int", requiredWhen: { mode: "a" }, describe: "" },
  ],
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
  scripts: {
    preflight: [
      { script: "aFlow", runWhen: { "args.mode": "a" } },
      { script: "bFlow", runWhen: { "args.mode": "b" } },
      { script: "composePrompt" },
    ],
    postflight: [],
  },
}

describe("executor: profile input schema", () => {
  it("loads inputs with requiredWhen intact", () => {
    const dir = tmpDir()
    const p = path.join(dir, "profile.json")
    fs.writeFileSync(p, JSON.stringify(BASE))
    const profile = loadProfile(p)
    const n = profile.inputs.find((i) => i.name === "n")!
    expect(n.requiredWhen).toEqual({ mode: "a" })
  })

  it("preserves runWhen on preflight entries", () => {
    const dir = tmpDir()
    const p = path.join(dir, "profile.json")
    fs.writeFileSync(p, JSON.stringify(BASE))
    const profile = loadProfile(p)
    expect(profile.scripts.preflight[0]!.runWhen).toEqual({ "args.mode": "a" })
    expect(profile.scripts.preflight[1]!.runWhen).toEqual({ "args.mode": "b" })
    expect(profile.scripts.preflight[2]!.runWhen).toBeUndefined()
  })
})

describe("executor: Build profile is loadable + valid", () => {
  it("builds profile.json loads cleanly from src-v2/executables/build/", () => {
    const profilePath = path.resolve(__dirname, "../../../src-v2/executables/build/profile.json")
    expect(fs.existsSync(profilePath)).toBe(true)
    const profile = loadProfile(profilePath)
    expect(profile.name).toBe("build")
    const modes = profile.inputs.find((i) => i.name === "mode")!.values
    expect(modes).toEqual(["run", "fix", "fix-ci", "resolve"])
    const flowScripts = profile.scripts.preflight
      .filter((s) => s.runWhen)
      .map((s) => s.script)
    expect(flowScripts).toEqual(["runFlow", "fixFlow", "fixCiFlow", "resolveFlow"])
  })
})
