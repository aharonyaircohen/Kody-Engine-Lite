import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { checkModelHealth } from "../../src/cli/litellm.js"

describe("checkModelHealth", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(body: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }

  it("accepts Anthropic format with text content block", async () => {
    mockFetch({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    })

    const result = await checkModelHealth("http://localhost:4000", "key", "model")
    expect(result.ok).toBe(true)
  })

  it("accepts Anthropic format with thinking content block", async () => {
    mockFetch({
      role: "assistant",
      content: [{ type: "thinking", thinking: "..." }],
    })

    const result = await checkModelHealth("http://localhost:4000", "key", "model")
    expect(result.ok).toBe(true)
  })

  it("accepts OpenAI format", async () => {
    mockFetch({
      choices: [{ message: { content: "ok" } }],
    })

    const result = await checkModelHealth("http://localhost:4000", "key", "model")
    expect(result.ok).toBe(true)
  })

  it("accepts empty content array with assistant role (Gemini via LiteLLM)", async () => {
    mockFetch({
      id: "test-id",
      type: "message",
      role: "assistant",
      model: "gemini-2.5-flash",
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    })

    const result = await checkModelHealth("http://localhost:4000", "key", "gemini-2.5-flash")
    expect(result.ok).toBe(true)
  })

  it("rejects response with no content array and no choices", async () => {
    mockFetch({
      id: "test-id",
      model: "unknown",
    })

    const result = await checkModelHealth("http://localhost:4000", "key", "model")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unexpected response format")
  })

  it("rejects empty content array without assistant role", async () => {
    mockFetch({
      content: [],
    })

    const result = await checkModelHealth("http://localhost:4000", "key", "model")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unexpected response format")
  })

  it("returns error on HTTP failure", async () => {
    mockFetch({ error: "unauthorized" }, 401)

    const result = await checkModelHealth("http://localhost:4000", "key", "model")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("HTTP 401")
  })

  it("returns error on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"))

    const result = await checkModelHealth("http://localhost:4000", "key", "model")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Connection refused")
  })
})
