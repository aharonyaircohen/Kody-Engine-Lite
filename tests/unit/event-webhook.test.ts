/**
 * Unit tests for the webhook hook.
 *
 * Verifies:
 * 1. Skips silently (skipped: true) when KODY_WEBHOOK_URL is not set
 * 2. POSTs correct normalized payload when URL is set
 * 3. Includes Authorization: Bearer header when KODY_WEBHOOK_TOKEN is set
 * 4. Uses config overrides for url/token when passed directly
 * 5. Returns success: false on HTTP failure without throwing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { KodyEvent } from "../../src/events/types.js"

// Shared mutable state for the fetch mock — referenced via closure so all
// layers (beforeEach stub and test-body overrides) write to the same object.
const fetchMockState = {
  postedRequests: [] as Array<{
    url: string
    method: string
    headers: Record<string, string>
    body: unknown
  }>,
  responseStatus: 200,
  responseStatusText: "OK",
  shouldThrow: false,
}

function makeFetchMock() {
  return async (url: string, init: RequestInit) => {
    if (fetchMockState.shouldThrow) {
      throw new Error("ENOTFOUND")
    }
    fetchMockState.postedRequests.push({
      url: url as string,
      method: init.method as string,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    })
    return {
      ok: fetchMockState.responseStatus >= 200 && fetchMockState.responseStatus < 300,
      status: fetchMockState.responseStatus,
      statusText: fetchMockState.responseStatusText,
    } as unknown as Response
  }
}

beforeEach(() => {
  // Reset shared state (not the mock reference — the shared object)
  fetchMockState.postedRequests = []
  fetchMockState.responseStatus = 200
  fetchMockState.responseStatusText = "OK"
  fetchMockState.shouldThrow = false

  // Stub fetch once here; test bodies update fetchMockState, not the stub itself
  vi.stubGlobal("fetch", makeFetchMock())

  // Clear env vars
  delete process.env.KODY_WEBHOOK_URL
  delete process.env.KODY_WEBHOOK_TOKEN
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeEvent(name: string = "step.complete"): KodyEvent {
  return {
    name: name as KodyEvent["name"],
    payload: {
      runId: "run-123",
      step: "build",
      sessionId: "sess-abc",
      issueNumber: 42,
    } as unknown as KodyEvent["payload"],
    emittedAt: new Date("2026-04-13T10:00:00.000Z"),
  }
}

const mockContext = { runId: "run-123" }

async function loadWebhookHook() {
  const mod = await import("../../src/event-system/hooks/impl/webhook.js")
  return mod.webhookHook
}

describe("webhook hook", () => {
  it("skips silently when KODY_WEBHOOK_URL is not set", async () => {
    const hook = await loadWebhookHook()
    const result = await hook.handle(makeEvent(), mockContext)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ skipped: true })
    expect(fetchMockState.postedRequests).toHaveLength(0)
  })

  it("skips silently when KODY_WEBHOOK_URL is empty string", async () => {
    process.env.KODY_WEBHOOK_URL = ""
    const hook = await loadWebhookHook()
    const result = await hook.handle(makeEvent(), mockContext)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ skipped: true })
    expect(fetchMockState.postedRequests).toHaveLength(0)
  })

  it("POSTs correct normalized payload when URL is set via env var", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"

    const hook = await loadWebhookHook()
    await hook.handle(makeEvent(), mockContext)

    expect(fetchMockState.postedRequests).toHaveLength(1)
    const req = fetchMockState.postedRequests[0]
    expect(req.url).toBe("https://my-dashboard.com/api/webhook")
    expect(req.method).toBe("POST")
    expect(req.headers["Content-Type"]).toBe("application/json")
    expect(req.headers["User-Agent"]).toBe("Kody-Engine-Lite/1.0")
    expect((req.body as any).eventName).toBe("step.complete")
    expect((req.body as any).runId).toBe("run-123")
    expect((req.body as any).sessionId).toBe("sess-abc")
    expect((req.body as any).issueNumber).toBe(42)
    expect((req.body as any).payload).toBeTruthy()
    expect((req.body as any).eventId).toBeTruthy()
    expect((req.body as any).emittedAt).toBe("2026-04-13T10:00:00.000Z")
  })

  it("includes Authorization: Bearer header when KODY_WEBHOOK_TOKEN is set", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"
    process.env.KODY_WEBHOOK_TOKEN = "sk-event-secret123"

    const hook = await loadWebhookHook()
    await hook.handle(makeEvent(), mockContext)

    expect(fetchMockState.postedRequests).toHaveLength(1)
    expect(fetchMockState.postedRequests[0].headers["Authorization"]).toBe("Bearer sk-event-secret123")
  })

  it("uses config url override when provided", async () => {
    // Env var is set but config override should win
    process.env.KODY_WEBHOOK_URL = "https://fallback.com/webhook"

    const hook = await loadWebhookHook()
    await hook.handle(makeEvent(), mockContext, {
      type: "webhook",
      url: "https://override.com/hook",
    })

    expect(fetchMockState.postedRequests[0].url).toBe("https://override.com/hook")
  })

  it("uses config token override when provided", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"
    process.env.KODY_WEBHOOK_TOKEN = "env-token"

    const hook = await loadWebhookHook()
    await hook.handle(makeEvent(), mockContext, {
      type: "webhook",
      token: "config-token",
    })

    expect(fetchMockState.postedRequests[0].headers["Authorization"]).toBe("Bearer config-token")
  })

  it("returns success: true on HTTP 200 response", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"
    fetchMockState.responseStatus = 200
    fetchMockState.responseStatusText = "OK"

    const hook = await loadWebhookHook()
    const result = await hook.handle(makeEvent(), mockContext)

    expect(result.success).toBe(true)
    expect(result.hookType).toBe("webhook")
    expect((result.data as any).url).toBe("https://my-dashboard.com/api/webhook")
    expect((result.data as any).eventName).toBe("step.complete")
  })

  it("returns success: false without throwing on HTTP 500", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"
    fetchMockState.responseStatus = 500
    fetchMockState.responseStatusText = "Internal Server Error"

    const hook = await loadWebhookHook()
    const result = await hook.handle(makeEvent(), mockContext)

    expect(result.success).toBe(false)
    expect(result.hookType).toBe("webhook")
    expect(result.error).toContain("500")
  })

  it("returns success: false without throwing on network error", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"
    fetchMockState.shouldThrow = true

    const hook = await loadWebhookHook()
    const result = await hook.handle(makeEvent(), mockContext)

    expect(result.success).toBe(false)
    expect(result.hookType).toBe("webhook")
    expect(result.error).toBe("ENOTFOUND")
  })

  it("includes runId from context in the payload", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"

    const hook = await loadWebhookHook()
    await hook.handle(makeEvent("pipeline.started"), { runId: "custom-run-id" })

    expect((fetchMockState.postedRequests[0].body as any).runId).toBe("custom-run-id")
  })

  it("normalizes Date emittedAt to ISO string", async () => {
    process.env.KODY_WEBHOOK_URL = "https://my-dashboard.com/api/webhook"

    const hook = await loadWebhookHook()
    await hook.handle(makeEvent(), mockContext)

    expect(typeof (fetchMockState.postedRequests[0].body as any).emittedAt).toBe("string")
    expect((fetchMockState.postedRequests[0].body as any).emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
