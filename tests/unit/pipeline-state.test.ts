import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { loadState, writeState, initState } from "../../src/pipeline/state.js"

describe("pipeline state", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-state-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("initState", () => {
    it("creates state with all stages pending", () => {
      const state = initState("test-123")
      expect(state.taskId).toBe("test-123")
      expect(state.state).toBe("running")
      expect(state.stages.taskify.state).toBe("pending")
      expect(state.stages.build.state).toBe("pending")
      expect(state.stages.ship.state).toBe("pending")
    })

    it("sets timestamps", () => {
      const state = initState("test-123")
      expect(state.createdAt).toBeTruthy()
      expect(state.updatedAt).toBeTruthy()
    })
  })

  describe("writeState / loadState", () => {
    it("round-trips state to disk", () => {
      const state = initState("test-456")
      writeState(state, tmpDir)

      const loaded = loadState("test-456", tmpDir)
      expect(loaded).not.toBeNull()
      expect(loaded!.taskId).toBe("test-456")
      expect(loaded!.state).toBe("running")
    })

    it("returns null for wrong taskId", () => {
      const state = initState("test-789")
      writeState(state, tmpDir)

      const loaded = loadState("different-id", tmpDir)
      expect(loaded).toBeNull()
    })

    it("returns null if no file exists", () => {
      const loaded = loadState("test-111", tmpDir)
      expect(loaded).toBeNull()
    })

    it("returns null for invalid JSON", () => {
      fs.writeFileSync(path.join(tmpDir, "status.json"), "not json")
      const loaded = loadState("test-222", tmpDir)
      expect(loaded).toBeNull()
    })

    it("updates updatedAt on write", () => {
      const state = initState("test-333")
      // Manually set an old timestamp to verify it gets updated
      state.updatedAt = "2020-01-01T00:00:00.000Z"
      state.stages.taskify.state = "completed"
      writeState(state, tmpDir)
      expect(state.updatedAt).not.toBe("2020-01-01T00:00:00.000Z")
    })
  })
})
