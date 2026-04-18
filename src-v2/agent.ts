import { query } from "@anthropic-ai/claude-agent-sdk"
import * as fs from "fs"
import * as path from "path"
import { renderEvent, type SdkMessageLike } from "./format.js"
import { getAnthropicApiKeyOrDummy, type ProviderModel } from "./config.js"

export interface AgentResult {
  outcome: "completed" | "failed"
  finalText: string
  error?: string
  ndjsonPath: string
}

export interface AgentOptions {
  prompt: string
  model: ProviderModel
  cwd: string
  litellmUrl?: string | null
  verbose?: boolean
  quiet?: boolean
  ndjsonDir?: string
}

const ALLOWED_TOOLS = ["Bash", "Edit", "Read", "Write", "Glob", "Grep"]

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const ndjsonDir = opts.ndjsonDir ?? path.join(opts.cwd, ".kody-lean")
  fs.mkdirSync(ndjsonDir, { recursive: true })
  const ndjsonPath = path.join(ndjsonDir, "last-run.jsonl")
  const fullLog = fs.createWriteStream(ndjsonPath, { flags: "w" })

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    SKIP_HOOKS: "1",
    HUSKY: "0",
    CI: process.env.CI ?? "1",
  }
  if (opts.litellmUrl) {
    env.ANTHROPIC_BASE_URL = opts.litellmUrl
    env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  let finalText = ""
  let outcome: "completed" | "failed" = "failed"
  let errorMessage: string | undefined

  try {
    const result = query({
      prompt: opts.prompt,
      options: {
        model: opts.model.model,
        cwd: opts.cwd,
        allowedTools: ALLOWED_TOOLS,
        permissionMode: "acceptEdits",
        env,
      },
    })

    for await (const msg of result) {
      try { fullLog.write(JSON.stringify(msg) + "\n") } catch { /* best effort */ }

      const line = renderEvent(msg as SdkMessageLike, { verbose: opts.verbose, quiet: opts.quiet })
      if (line) process.stdout.write(line + "\n")

      const m = msg as SdkMessageLike
      if (m.type === "result") {
        if (m.subtype === "success") {
          outcome = "completed"
          finalText = (typeof m.result === "string" ? m.result : "").trim()
        } else {
          outcome = "failed"
          errorMessage = `result subtype: ${m.subtype ?? "unknown"}`
        }
      }
    }
  } catch (e) {
    outcome = "failed"
    errorMessage = e instanceof Error ? e.message : String(e)
  } finally {
    try { fullLog.end() } catch { /* best effort */ }
  }

  return { outcome, finalText, error: errorMessage, ndjsonPath }
}
