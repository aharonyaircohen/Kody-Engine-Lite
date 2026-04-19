/**
 * Profile loader + validator.
 *
 * Reads an executable profile.json from disk, applies permissive defaults,
 * and checks invariants (every referenced script exists in the registry,
 * every input spec is well-formed, etc.). The executor treats a loaded
 * Profile as trustworthy.
 */

import * as fs from "fs"
import * as path from "path"
import type { Profile, InputSpec, ScriptEntry, CliToolSpec, ClaudeCodeSpec } from "./executables/types.js"

const VALID_INPUT_TYPES = new Set(["int", "string", "bool", "enum"])
const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"])

export class ProfileError extends Error {
  constructor(public profilePath: string, message: string) {
    super(`Invalid profile at ${profilePath}:\n  ${message}`)
    this.name = "ProfileError"
  }
}

export function loadProfile(profilePath: string): Profile {
  if (!fs.existsSync(profilePath)) {
    throw new ProfileError(profilePath, "file not found")
  }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(profilePath, "utf-8"))
  } catch (err) {
    throw new ProfileError(profilePath, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!raw || typeof raw !== "object") {
    throw new ProfileError(profilePath, "profile must be a JSON object")
  }

  const r = raw as Record<string, unknown>

  const profile: Profile = {
    name: requireString(profilePath, r, "name"),
    describe: typeof r.describe === "string" ? r.describe : "",
    inputs: parseInputs(profilePath, r.inputs),
    claudeCode: parseClaudeCode(profilePath, r.claudeCode),
    cliTools: parseCliTools(profilePath, r.cliTools),
    scripts: parseScripts(profilePath, r.scripts),
    outputContract: r.outputContract as Profile["outputContract"],
    dir: path.dirname(profilePath),
  }

  return profile
}

/**
 * Second-pass validation that every script referenced by the profile is
 * registered. Called by the executor after it imports the script catalog.
 */
export function validateScriptReferences(
  profile: Profile,
  registeredScripts: Set<string>,
): string[] {
  const missing: string[] = []
  for (const e of [...profile.scripts.preflight, ...profile.scripts.postflight]) {
    if (!registeredScripts.has(e.script)) missing.push(e.script)
  }
  return missing
}

// ────────────────────────────────────────────────────────────────────────────

function requireString(p: string, r: Record<string, unknown>, key: string): string {
  const v = r[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new ProfileError(p, `"${key}" must be a non-empty string`)
  }
  return v
}

function parseInputs(p: string, raw: unknown): InputSpec[] {
  if (!Array.isArray(raw)) throw new ProfileError(p, `"inputs" must be an array`)
  const out: InputSpec[] = []
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `inputs[${i}] must be an object`)
    }
    const r = item as Record<string, unknown>
    const name = requireString(p, r, "name")
    const flag = requireString(p, r, "flag")
    const type = requireString(p, r, "type") as InputSpec["type"]
    if (!VALID_INPUT_TYPES.has(type)) {
      throw new ProfileError(p, `inputs[${i}].type must be one of int|string|bool|enum`)
    }
    const spec: InputSpec = {
      name, flag, type,
      describe: typeof r.describe === "string" ? r.describe : "",
    }
    if (type === "enum") {
      if (!Array.isArray(r.values) || r.values.length === 0) {
        throw new ProfileError(p, `inputs[${i}] (enum) requires non-empty "values" array`)
      }
      spec.values = r.values as string[]
    }
    if (typeof r.required === "boolean") spec.required = r.required
    if (r.requiredWhen && typeof r.requiredWhen === "object") {
      spec.requiredWhen = r.requiredWhen as InputSpec["requiredWhen"]
    }
    out.push(spec)
  }
  return out
}

function parseClaudeCode(p: string, raw: unknown): ClaudeCodeSpec {
  if (!raw || typeof raw !== "object") {
    throw new ProfileError(p, `"claudeCode" must be an object`)
  }
  const r = raw as Record<string, unknown>

  const permissionMode = (typeof r.permissionMode === "string" ? r.permissionMode : "acceptEdits") as ClaudeCodeSpec["permissionMode"]
  if (!VALID_PERMISSION_MODES.has(permissionMode)) {
    throw new ProfileError(p, `claudeCode.permissionMode must be one of default|acceptEdits|plan|bypassPermissions`)
  }

  const tools = Array.isArray(r.tools) ? (r.tools as string[]) : []
  if (tools.length === 0) {
    throw new ProfileError(p, `claudeCode.tools must declare at least one SDK tool`)
  }

  const hooksRaw = (r.hooks ?? {}) as Record<string, unknown>
  const hooks = {
    PreToolUse: Array.isArray(hooksRaw.PreToolUse) ? (hooksRaw.PreToolUse as ClaudeCodeSpec["hooks"]["PreToolUse"]) : [],
    PostToolUse: Array.isArray(hooksRaw.PostToolUse) ? (hooksRaw.PostToolUse as ClaudeCodeSpec["hooks"]["PostToolUse"]) : [],
    Stop: Array.isArray(hooksRaw.Stop) ? (hooksRaw.Stop as ClaudeCodeSpec["hooks"]["Stop"]) : [],
  }

  return {
    model: typeof r.model === "string" ? r.model : "inherit",
    permissionMode,
    maxTurns: typeof r.maxTurns === "number" ? r.maxTurns : null,
    systemPromptAppend: typeof r.systemPromptAppend === "string" ? r.systemPromptAppend : null,
    tools,
    hooks,
    skills: Array.isArray(r.skills) ? (r.skills as string[]) : [],
    commands: Array.isArray(r.commands) ? (r.commands as string[]) : [],
    subagents: Array.isArray(r.subagents) ? (r.subagents as string[]) : [],
    plugins: Array.isArray(r.plugins) ? (r.plugins as string[]) : [],
    mcpServers: Array.isArray(r.mcpServers) ? (r.mcpServers as ClaudeCodeSpec["mcpServers"]) : [],
  }
}

function parseCliTools(p: string, raw: unknown): CliToolSpec[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ProfileError(p, `"cliTools" must be an array or absent`)
  const out: CliToolSpec[] = []
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `cliTools[${i}] must be an object`)
    }
    const r = item as Record<string, unknown>
    const install = r.install as Record<string, unknown> | undefined
    if (!install || typeof install !== "object") {
      throw new ProfileError(p, `cliTools[${i}].install must be an object`)
    }
    out.push({
      name: requireString(p, r, "name"),
      install: {
        required: Boolean(install.required),
        checkCommand: requireString(p, install as Record<string, unknown>, "checkCommand"),
        installCommand: typeof install.installCommand === "string" ? install.installCommand : undefined,
      },
      verify: requireString(p, r, "verify"),
      usage: typeof r.usage === "string" ? r.usage : "",
      allowedUses: Array.isArray(r.allowedUses) ? (r.allowedUses as string[]) : [],
    })
  }
  return out
}

function parseScripts(p: string, raw: unknown): Profile["scripts"] {
  if (!raw || typeof raw !== "object") {
    throw new ProfileError(p, `"scripts" must be an object with preflight and postflight arrays`)
  }
  const r = raw as Record<string, unknown>
  return {
    preflight: parseScriptList(p, "preflight", r.preflight),
    postflight: parseScriptList(p, "postflight", r.postflight),
  }
}

function parseScriptList(p: string, key: string, raw: unknown): ScriptEntry[] {
  if (!Array.isArray(raw)) {
    throw new ProfileError(p, `scripts.${key} must be an array`)
  }
  const out: ScriptEntry[] = []
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `scripts.${key}[${i}] must be an object like { script, runWhen? }`)
    }
    const r = item as Record<string, unknown>
    const script = requireString(p, r, "script")
    const entry: ScriptEntry = { script }
    if (r.runWhen && typeof r.runWhen === "object") {
      entry.runWhen = r.runWhen as ScriptEntry["runWhen"]
    }
    out.push(entry)
  }
  return out
}
