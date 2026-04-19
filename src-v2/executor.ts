/**
 * The generic executor.
 *
 * Reads a Profile, validates CLI args, verifies required CLI tools, runs
 * declared preflight scripts, invokes Claude Code, runs declared postflight
 * scripts. Knows nothing about build/review/plan — only about the profile
 * it was handed and the script catalog.
 */

import * as fs from "fs"
import * as path from "path"
import type { Kody2Config } from "./config.js"
import type { Context, Profile, ScriptEntry, InputSpec } from "./executables/types.js"
import type { AgentResult } from "./agent.js"
import { loadProfile, validateScriptReferences } from "./profile.js"
import { allScriptNames, preflightScripts, postflightScripts } from "./scripts/index.js"
import { runAgent } from "./agent.js"
import { verifyCliTools, firstRequiredFailure } from "./tools.js"
import { startLitellmIfNeeded } from "./litellm.js"
import { parseProviderModel } from "./config.js"

export interface ExecutorInput {
  cliArgs: Record<string, unknown>
  cwd: string
  config: Kody2Config
  verbose?: boolean
  quiet?: boolean
}

export interface ExecutorOutput {
  exitCode: number
  prUrl?: string
  reason?: string
}

export async function runExecutable(profileName: string, input: ExecutorInput): Promise<ExecutorOutput> {
  const profilePath = resolveProfilePath(profileName)
  const profile = loadProfile(profilePath)

  const missing = validateScriptReferences(profile, allScriptNames)
  if (missing.length > 0) {
    return finish({ exitCode: 99, reason: `profile references unknown scripts: ${missing.join(", ")}` })
  }

  // Validate and coerce CLI args.
  let args: Record<string, unknown>
  try {
    args = validateInputs(profile.inputs, input.cliArgs)
  } catch (err) {
    return finish({ exitCode: 64, reason: err instanceof Error ? err.message : String(err) })
  }

  // Verify required CLI tools up front.
  const toolResults = verifyCliTools(profile.cliTools, input.cwd)
  const firstFail = firstRequiredFailure(toolResults, profile.cliTools)
  if (firstFail) {
    return finish({ exitCode: 99, reason: `required CLI tool check failed: ${firstFail.error}` })
  }

  // Resolve model (profile "inherit" → config.agent.model).
  const modelSpec = profile.claudeCode.model === "inherit"
    ? input.config.agent.model
    : profile.claudeCode.model
  let model
  try { model = parseProviderModel(modelSpec) }
  catch (err) { return finish({ exitCode: 99, reason: `agent.model invalid: ${err instanceof Error ? err.message : String(err)}` }) }

  // Start LiteLLM for non-anthropic providers.
  let litellm: Awaited<ReturnType<typeof startLitellmIfNeeded>> = null
  try { litellm = await startLitellmIfNeeded(model, input.cwd) }
  catch (err) { return finish({ exitCode: 99, reason: `litellm startup failed: ${err instanceof Error ? err.message : String(err)}` }) }

  const ctx: Context = {
    args,
    cwd: input.cwd,
    config: input.config,
    verbose: input.verbose,
    quiet: input.quiet,
    data: {},
    output: { exitCode: 0 },
  }

  const ndjsonDir = path.join(input.cwd, ".kody2")
  const invokeAgent = async (prompt: string): Promise<AgentResult> =>
    runAgent({
      prompt,
      model,
      cwd: input.cwd,
      litellmUrl: litellm?.url ?? null,
      verbose: input.verbose,
      quiet: input.quiet,
      ndjsonDir,
      allowedToolsOverride: profile.claudeCode.tools,
      permissionModeOverride: profile.claudeCode.permissionMode,
    })

  // Stash for checkCoverageWithRetry.
  ctx.data.__invokeAgent = invokeAgent

  try {
    // ── Preflight ────────────────────────────────────────────────────────────
    for (const entry of profile.scripts.preflight) {
      if (!shouldRun(entry, ctx)) continue
      const fn = preflightScripts[entry.script]
      if (!fn) return finish({ exitCode: 99, reason: `preflight script not registered: ${entry.script}` })
      await fn(ctx, profile)
      if (ctx.skipAgent && ctx.output.exitCode !== undefined && ctx.output.exitCode !== 0) {
        // Hard bail from preflight (e.g. uncommitted-changes refusal).
        return finish(ctx.output)
      }
    }

    // ── Agent ─────────────────────────────────────────────────────────────────
    let agentResult: AgentResult | null = null
    if (!ctx.skipAgent) {
      const prompt = ctx.data.prompt as string | undefined
      if (!prompt) {
        return finish({ exitCode: 99, reason: "composePrompt did not produce a prompt (ctx.data.prompt missing)" })
      }
      agentResult = await invokeAgent(prompt)
    }

    // ── Postflight ────────────────────────────────────────────────────────────
    for (const entry of profile.scripts.postflight) {
      if (!shouldRun(entry, ctx)) continue
      const fn = postflightScripts[entry.script]
      if (!fn) return finish({ exitCode: 99, reason: `postflight script not registered: ${entry.script}` })
      await fn(ctx, profile, agentResult)
    }

    return finish(ctx.output)
  } finally {
    try { litellm?.kill() } catch { /* best effort */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────

function resolveProfilePath(profileName: string): string {
  // Resolve profile in both layouts:
  //   - dev / tsx: src-v2/executor.ts    → src-v2/executables/<name>/profile.json
  //   - prod bundle: dist/bin-v2/kody2.js → dist/executables/<name>/profile.json
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "executables", profileName, "profile.json"),             // same-dir sibling (dev)
    path.join(here, "..", "executables", profileName, "profile.json"),       // up one (prod: dist/bin-v2 → dist/executables)
    path.join(here, "..", "src-v2", "executables", profileName, "profile.json"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]!
}

function validateInputs(specs: InputSpec[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  // First pass: type coerce provided values.
  for (const spec of specs) {
    const v = raw[spec.name]
    if (v === undefined || v === null) continue
    out[spec.name] = coerce(spec, v)
  }

  // Second pass: enforce required / requiredWhen.
  for (const spec of specs) {
    const present = out[spec.name] !== undefined
    if (present) continue
    const isRequired = spec.required === true || satisfiesRequiredWhen(spec.requiredWhen, out)
    if (isRequired) {
      throw new Error(`required input missing: ${spec.flag} (${spec.name})`)
    }
  }

  return out
}

function coerce(spec: InputSpec, v: unknown): unknown {
  switch (spec.type) {
    case "int": {
      const n = typeof v === "number" ? v : parseInt(String(v), 10)
      if (Number.isNaN(n)) throw new Error(`${spec.flag} must be an integer`)
      return n
    }
    case "bool": {
      if (typeof v === "boolean") return v
      const s = String(v).toLowerCase()
      return s === "true" || s === "1" || s === "yes"
    }
    case "enum": {
      const s = String(v)
      if (!spec.values?.includes(s)) throw new Error(`${spec.flag} must be one of: ${spec.values?.join("|")}`)
      return s
    }
    default: return String(v)
  }
}

function satisfiesRequiredWhen(rw: InputSpec["requiredWhen"], current: Record<string, unknown>): boolean {
  if (!rw) return false
  for (const [key, want] of Object.entries(rw)) {
    const actual = String(current[key] ?? "")
    const wanted = Array.isArray(want) ? want.map(String) : [String(want)]
    if (wanted.includes(actual)) return true
  }
  return false
}

function shouldRun(entry: ScriptEntry, ctx: Context): boolean {
  if (!entry.runWhen) return true
  for (const [key, want] of Object.entries(entry.runWhen)) {
    const actual = resolveDottedPath(ctx, key)
    const wanted = Array.isArray(want) ? want : [want]
    if (!wanted.map(String).includes(String(actual))) return false
  }
  return true
}

function resolveDottedPath(root: unknown, key: string): unknown {
  const parts = key.split(".")
  let cur: unknown = root
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function finish(out: ExecutorOutput): ExecutorOutput {
  if (out.prUrl) process.stdout.write(`PR_URL=${out.prUrl}\n`)
  else if (out.reason) process.stdout.write(`PR_URL=FAILED: ${out.reason}\n`)
  return out
}
