import { describe, it, expect } from "vitest"
import { renderEvent, type SdkMessageLike } from "../../../src-v2/format.js"

describe("format: renderEvent", () => {
  it("renders assistant text", () => {
    const msg: SdkMessageLike = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    }
    expect(renderEvent(msg)).toBe("Hello world")
  })

  it("renders tool_use as one line with arrow", () => {
    const msg: SdkMessageLike = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/x.ts" } }] },
    }
    expect(renderEvent(msg)).toBe("→ Read src/x.ts")
  })

  it("summarizes Bash command on one line", () => {
    const msg: SdkMessageLike = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm typecheck" } }] },
    }
    expect(renderEvent(msg)).toBe("→ Bash: pnpm typecheck")
  })

  it("renders tool_result as size summary by default", () => {
    const msg: SdkMessageLike = {
      type: "user",
      message: { content: [{ type: "tool_result", content: "line1\nline2\nline3" }] },
    }
    const result = renderEvent(msg)
    expect(result).toMatch(/3 lines/)
    expect(result).not.toMatch(/line1/)
  })

  it("includes raw content when verbose=true", () => {
    const msg: SdkMessageLike = {
      type: "user",
      message: { content: [{ type: "tool_result", content: "hello world" }] },
    }
    const result = renderEvent(msg, { verbose: true })
    expect(result).toMatch(/hello world/)
  })

  it("flags errored tool_result", () => {
    const msg: SdkMessageLike = {
      type: "user",
      message: { content: [{ type: "tool_result", content: "boom", is_error: true }] },
    }
    const result = renderEvent(msg)
    expect(result).toMatch(/ERROR/)
  })

  it("formats result with success tag and timing", () => {
    const msg: SdkMessageLike = {
      type: "result",
      subtype: "success",
      duration_ms: 12_500,
      num_turns: 8,
      total_cost_usd: 0.0125,
    }
    const result = renderEvent(msg)
    expect(result).toMatch(/DONE/)
    expect(result).toMatch(/12\.5s/)
    expect(result).toMatch(/8 turns/)
    expect(result).toMatch(/\$0\.0125/)
  })

  it("formats result with FAILED tag for non-success", () => {
    const msg: SdkMessageLike = { type: "result", subtype: "error_max_turns" }
    const result = renderEvent(msg)
    expect(result).toMatch(/FAILED/)
    expect(result).toMatch(/error_max_turns/)
  })

  it("returns null for system messages", () => {
    expect(renderEvent({ type: "system" })).toBeNull()
  })

  it("quiet=true suppresses everything except result", () => {
    const tu: SdkMessageLike = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }
    expect(renderEvent(tu, { quiet: true })).toBeNull()
    const r: SdkMessageLike = { type: "result", subtype: "success" }
    expect(renderEvent(r, { quiet: true })).toMatch(/DONE/)
  })
})
