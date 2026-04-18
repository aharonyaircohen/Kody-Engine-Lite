export interface SdkMessageLike {
  type: string
  subtype?: string
  result?: unknown
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; name: string; input?: Record<string, unknown> }
      | { type: "tool_result"; content?: unknown; is_error?: boolean }
      | { type: string; [key: string]: unknown }
    >
  }
  duration_ms?: number
  duration_api_ms?: number
  total_cost_usd?: number
  num_turns?: number
}

export interface RenderOptions {
  verbose?: boolean
  quiet?: boolean
}

export function renderEvent(msg: SdkMessageLike, opts: RenderOptions = {}): string | null {
  if (opts.quiet) {
    if (msg.type === "result") return formatResult(msg)
    return null
  }

  switch (msg.type) {
    case "system":
      return null
    case "assistant":
      return formatAssistant(msg, opts)
    case "user":
      return formatUserToolResult(msg, opts)
    case "result":
      return formatResult(msg)
    default:
      return null
  }
}

function formatAssistant(msg: SdkMessageLike, opts: RenderOptions): string | null {
  const content = msg.message?.content ?? []
  const lines: string[] = []
  for (const block of content) {
    if (block.type === "text") {
      const text = (block as { text: string }).text.trim()
      if (text) lines.push(text)
    } else if (block.type === "tool_use") {
      const tu = block as { name: string; input?: Record<string, unknown> }
      lines.push(`→ ${tu.name}${summarizeToolInput(tu.name, tu.input)}`)
    }
  }
  return lines.length > 0 ? lines.join("\n") : null
}

function formatUserToolResult(msg: SdkMessageLike, opts: RenderOptions): string | null {
  const content = msg.message?.content ?? []
  const lines: string[] = []
  for (const block of content) {
    if (block.type === "tool_result") {
      const tr = block as { content?: unknown; is_error?: boolean }
      const text = stringifyToolContent(tr.content)
      const lineCount = text.split("\n").length
      const sizeBytes = text.length
      const flag = tr.is_error ? " ERROR" : ""
      const summary = `  ↳${flag} ${lineCount} lines, ${formatBytes(sizeBytes)}`
      if (opts.verbose) {
        lines.push(`${summary}\n${truncate(text, 4000)}`)
      } else {
        lines.push(summary)
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : null
}

function formatResult(msg: SdkMessageLike): string {
  const ok = msg.subtype === "success"
  const tag = ok ? "DONE" : `FAILED (${msg.subtype ?? "unknown"})`
  const dur = msg.duration_ms ? ` ${(msg.duration_ms / 1000).toFixed(1)}s` : ""
  const turns = msg.num_turns ? ` ${msg.num_turns} turns` : ""
  const cost = typeof msg.total_cost_usd === "number" ? ` $${msg.total_cost_usd.toFixed(4)}` : ""
  return `\n=== ${tag}${dur}${turns}${cost} ===`
}

function summarizeToolInput(toolName: string, input: Record<string, unknown> = {}): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    const cmd = input.command.split("\n")[0]
    return `: ${truncate(cmd, 120)}`
  }
  if ((toolName === "Read" || toolName === "Edit" || toolName === "Write") && typeof input.file_path === "string") {
    return ` ${input.file_path}`
  }
  if ((toolName === "Glob" || toolName === "Grep") && typeof input.pattern === "string") {
    return `: ${truncate(input.pattern, 80)}`
  }
  return ""
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string") {
          return (b as { text: string }).text
        }
        return JSON.stringify(b)
      })
      .join("\n")
  }
  return JSON.stringify(content)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `… (+${s.length - max} chars)`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
