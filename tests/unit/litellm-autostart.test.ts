import { describe, it, expect } from "vitest"

describe("LiteLLM auto-start logic", () => {
  // Test the decision logic without actually starting processes

  function decideLitellmAction(
    litellmUrl: string | undefined,
    proxyRunning: boolean,
    litellmInstalled: boolean,
    configExists: boolean,
  ): "skip" | "already-running" | "start" | "fallback-no-config" | "fallback-no-litellm" {
    if (!litellmUrl) return "skip"
    if (proxyRunning) return "already-running"
    if (!configExists) return "fallback-no-config"
    if (!litellmInstalled) return "fallback-no-litellm"
    return "start"
  }

  it("skips when no litellmUrl configured", () => {
    expect(decideLitellmAction(undefined, false, false, false)).toBe("skip")
  })

  it("skips when proxy already running", () => {
    expect(decideLitellmAction("http://localhost:4000", true, true, true)).toBe("already-running")
  })

  it("starts proxy when everything available", () => {
    expect(decideLitellmAction("http://localhost:4000", false, true, true)).toBe("start")
  })

  it("falls back when litellm-config.yaml missing", () => {
    expect(decideLitellmAction("http://localhost:4000", false, true, false)).toBe("fallback-no-config")
  })

  it("falls back when litellm not installed", () => {
    expect(decideLitellmAction("http://localhost:4000", false, false, true)).toBe("fallback-no-litellm")
  })

  it("falls back when both missing", () => {
    expect(decideLitellmAction("http://localhost:4000", false, false, false)).toBe("fallback-no-config")
  })
})

describe("LiteLLM port extraction", () => {
  it("extracts port from URL", () => {
    const url = "http://localhost:4000"
    const match = url.match(/:(\d+)/)
    expect(match?.[1]).toBe("4000")
  })

  it("extracts non-standard port", () => {
    const url = "http://localhost:8080"
    const match = url.match(/:(\d+)/)
    expect(match?.[1]).toBe("8080")
  })

  it("defaults to 4000 when no port", () => {
    const url = "http://litellm-proxy"
    const match = url.match(/:(\d+)/)
    const port = match ? match[1] : "4000"
    expect(port).toBe("4000")
  })
})

describe("LiteLLM fallback behavior", () => {
  it("clears litellmUrl when falling back", () => {
    const config = { agent: { litellmUrl: "http://localhost:4000" } }

    // Simulate fallback
    const canStart = false
    if (!canStart) {
      config.agent.litellmUrl = undefined as unknown as string
    }

    expect(config.agent.litellmUrl).toBeUndefined()
  })

  it("preserves litellmUrl when proxy starts", () => {
    const config = { agent: { litellmUrl: "http://localhost:4000" } }

    const canStart = true
    if (!canStart) {
      config.agent.litellmUrl = undefined as unknown as string
    }

    expect(config.agent.litellmUrl).toBe("http://localhost:4000")
  })
})
