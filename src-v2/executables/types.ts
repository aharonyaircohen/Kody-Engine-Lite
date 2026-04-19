/**
 * Types shared by the generic executor and executables.
 *
 * The executor reads a Profile, validates the user's CLI args against
 * Profile.inputs, then runs the declared preflight scripts → agent →
 * postflight scripts. The executor knows nothing about any specific role
 * (build, review, plan, etc.) — it only executes what the profile declares.
 */

import type { Kody2Config } from "../config.js"
import type { AgentResult } from "../agent.js"

// ────────────────────────────────────────────────────────────────────────────
// Profile shape (mirrors the JSON on disk).
// ────────────────────────────────────────────────────────────────────────────

export interface Profile {
  name: string
  describe: string
  inputs: InputSpec[]
  claudeCode: ClaudeCodeSpec
  cliTools: CliToolSpec[]
  scripts: {
    preflight: ScriptEntry[]
    postflight: ScriptEntry[]
  }
  outputContract?: OutputContract
  /** Absolute directory the profile was loaded from. Used to resolve prompt.md. */
  dir: string
}

export interface InputSpec {
  name: string
  flag: string
  type: "int" | "string" | "bool" | "enum"
  /** Allowed values for `type: "enum"`. */
  values?: string[]
  required?: boolean
  /**
   * Only required when another input matches one of these values.
   * e.g. `{ mode: "run" }` or `{ mode: ["fix", "fix-ci", "resolve"] }`.
   */
  requiredWhen?: Record<string, string | string[]>
  describe: string
}

export interface ClaudeCodeSpec {
  /** "inherit" → use Kody2Config.agent.model. Or a concrete "provider/model". */
  model: string
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions"
  /** null = unbounded. */
  maxTurns: number | null
  /** Text appended on top of Claude Code's baseline system prompt. */
  systemPromptAppend: string | null
  /** SDK built-in tools this executable is allowed to use (capability pack). */
  tools: string[]
  /** Claude Code hooks. `matcher` is a tool-name glob; `command` is a shell invocation. */
  hooks: {
    PreToolUse: HookEntry[]
    PostToolUse: HookEntry[]
    Stop: HookEntry[]
  }
  skills: string[]
  commands: string[]
  subagents: string[]
  plugins: string[]
  mcpServers: McpServerSpec[]
}

export interface HookEntry {
  matcher: string
  command: string
}

export interface McpServerSpec {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface CliToolSpec {
  name: string
  install: {
    required: boolean
    checkCommand: string
    installCommand?: string
  }
  verify: string
  usage: string
  allowedUses: string[]
}

export interface ScriptEntry {
  script: string
  /**
   * Optional conditional. Keys are dotted paths into the context (e.g.
   * "args.mode"). Values are a single primitive or an array of primitives.
   * The script runs only when every key matches. Missing `runWhen` = always.
   */
  runWhen?: Record<string, string | number | boolean | Array<string | number | boolean>>
}

export interface OutputContract {
  finalMessage?: {
    onSuccess?: string[]
    onFailure?: string[]
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Run-time context passed to every script.
// ────────────────────────────────────────────────────────────────────────────

export interface Context {
  /** Validated CLI args, keyed by input `name`. */
  args: Record<string, unknown>
  /** Project root. */
  cwd: string
  /** Loaded kody.config.json. */
  config: Kody2Config
  /** Stream-output verbosity. */
  verbose?: boolean
  quiet?: boolean
  /** Opaque bag scripts populate during preflight (issue, pr, diff, logs, …). */
  data: Record<string, unknown>
  /** Final output the executor returns. */
  output: {
    exitCode: number
    prUrl?: string
    reason?: string
  }
  /**
   * If a preflight script sets this to true, the executor skips the agent
   * invocation and proceeds straight to postflight. Used by e.g. the
   * clean-merge resolve path.
   */
  skipAgent?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Script signatures. Two phases, two contracts.
// ────────────────────────────────────────────────────────────────────────────

export type PreflightScript = (ctx: Context, profile: Profile) => Promise<void>

export type PostflightScript = (
  ctx: Context,
  profile: Profile,
  agentResult: AgentResult | null,
) => Promise<void>

/** A registered script may be either phase; registry looks it up by name. */
export type AnyScript = PreflightScript | PostflightScript
