import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as http from "http"
import { startDevServer, type DevServerHandle } from "../../src/dev-server.js"

/**
 * Tests for the engine-managed dev server lifecycle.
 *
 * The dev server must be started by the engine process (not by Claude Code)
 * with a hard timeout, so that a hanging DB connection or slow startup
 * cannot block the entire pipeline indefinitely.
 */
describe("startDevServer", () => {
  let handle: DevServerHandle | null = null
  let mockServer: http.Server | null = null

  afterEach(async () => {
    if (handle) {
      handle.stop()
      handle = null
    }
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()))
      mockServer = null
    }
  })

  it("returns ready=true when server responds within timeout", async () => {
    // Start a real HTTP server to simulate the dev server
    mockServer = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    await new Promise<void>((resolve) => mockServer!.listen(0, resolve))
    const port = (mockServer.address() as { port: number }).port

    handle = await startDevServer({
      command: "echo running",
      url: `http://localhost:${port}`,
      readyTimeout: 5,
    })

    expect(handle.ready).toBe(true)
    expect(handle.url).toBe(`http://localhost:${port}`)
  })

  it("returns ready=false when server does not respond within timeout", async () => {
    // Use a port that nothing listens on
    handle = await startDevServer({
      command: "sleep 999",
      url: "http://localhost:19999",
      readyTimeout: 2,
    })

    expect(handle.ready).toBe(false)
  })

  it("stop() kills the spawned process", async () => {
    handle = await startDevServer({
      command: "sleep 999",
      url: "http://localhost:19998",
      readyTimeout: 1,
    })

    const pid = handle.pid
    expect(pid).toBeGreaterThan(0)

    handle.stop()

    // Give OS a moment to clean up
    await new Promise((r) => setTimeout(r, 100))

    // Process should no longer exist
    let alive = false
    try {
      process.kill(pid!, 0)
      alive = true
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
    handle = null // already stopped
  })

  it("forwards env vars from config", async () => {
    mockServer = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    await new Promise<void>((resolve) => mockServer!.listen(0, resolve))
    const port = (mockServer.address() as { port: number }).port

    handle = await startDevServer({
      command: "echo test",
      url: `http://localhost:${port}`,
      readyTimeout: 3,
      envVars: { TEST_VAR: "test_value" },
    })

    expect(handle.ready).toBe(true)
  })

  it("returns ready=false when command fails immediately", async () => {
    handle = await startDevServer({
      command: "exit 1",
      url: "http://localhost:19997",
      readyTimeout: 3,
    })

    expect(handle.ready).toBe(false)
  })
})
