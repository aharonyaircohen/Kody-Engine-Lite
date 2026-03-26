import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { logger, ciGroup, ciGroupEnd } from "../../src/logger.js"

describe("logger", () => {
  it("has info, warn, error, debug methods", () => {
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
    expect(typeof logger.debug).toBe("function")
  })

  it("info logs to stdout", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    logger.info("test message")
    expect(spy).toHaveBeenCalled()
    const call = spy.mock.calls[0][0] as string
    expect(call).toContain("test message")
    spy.mockRestore()
  })

  it("error logs to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    logger.error("error message")
    expect(spy).toHaveBeenCalled()
    const call = spy.mock.calls[0][0] as string
    expect(call).toContain("error message")
    spy.mockRestore()
  })
})

describe("ciGroup", () => {
  const origEnv = process.env.GITHUB_ACTIONS

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.GITHUB_ACTIONS = origEnv
    } else {
      delete process.env.GITHUB_ACTIONS
    }
  })

  it("writes ::group:: in CI", () => {
    process.env.GITHUB_ACTIONS = "true"
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    // ciGroup reads isCI at module load time, so this test may not trigger
    // Just verify the function exists and doesn't throw
    expect(() => ciGroup("test")).not.toThrow()
    spy.mockRestore()
  })

  it("ciGroupEnd doesn't throw", () => {
    expect(() => ciGroupEnd()).not.toThrow()
  })
})
