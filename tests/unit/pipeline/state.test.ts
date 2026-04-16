import { describe, it, expect, beforeEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import type { PipelineStatus, StageState } from "../../../src/types.js"
import { parseJsonSafe } from "../../../src/validators.js"

const STAGES = ["taskify", "plan", "build", "verify"] as const

function makeStatus(taskId: string): PipelineStatus {
  const stages = {} as Record<string, StageState>
  for (const s of STAGES) stages[s] = { state: "pending", retries: 0 }
  return { taskId, state: "running", stages, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }
}

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  copyFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
}))

vi.mock("../../../src/validators.js", () => ({
  parseJsonSafe: vi.fn((data: string) => ({ ok: true as const, data: JSON.parse(data) })),
}))

import { writeState, loadState } from "../../../src/pipeline/state.js"

describe("writeState return value (item #3)", () => {
  it("returns a new object distinct from the input", () => {
    const original = makeStatus("test-task")
    const next = writeState(original, "/tmp/task-dir")
    expect(next).not.toBe(original)
  })

  it("updates updatedAt to the current ISO timestamp", () => {
    const original = makeStatus("test-task")
    original.updatedAt = "1970-01-01T00:00:00Z"
    const next = writeState(original, "/tmp/task-dir")
    expect(next.updatedAt).not.toBe("1970-01-01T00:00:00Z")
    expect(next.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it("copies all other fields unchanged", () => {
    const original = makeStatus("my-task")
    const next = writeState(original, "/tmp/task-dir")
    expect(next.taskId).toBe("my-task")
    expect(next.state).toBe("running")
    expect(next.createdAt).toBe(original.createdAt)
  })
})

describe("status.json backup on write (item #7)", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.copyFileSync).mockClear()
    vi.mocked(fs.writeFileSync).mockClear()
  })

  it("backs up existing status.json before writing", () => {
    writeState(makeStatus("backup-test"), "/tmp/task-dir")
    expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledWith(
      path.join("/tmp/task-dir", "status.json"),
      path.join("/tmp/task-dir", "status.json.bak"),
    )
  })

  it("writes the new state to status.json", () => {
    writeState(makeStatus("write-test"), "/tmp/task-dir")
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      path.join("/tmp/task-dir", "status.json.tmp"),
      expect.any(String),
    )
  })

  it("renames the tmp file to status.json (atomic write)", () => {
    writeState(makeStatus("atomic-test"), "/tmp/task-dir")
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
      path.join("/tmp/task-dir", "status.json.tmp"),
      path.join("/tmp/task-dir", "status.json"),
    )
  })
})

describe("status.json restore from backup (item #7)", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
  })

  it("restores from backup when status.json is corrupt", () => {
    // First call (loadState): status.json is corrupt
    // Second call (loadStateFromBackup): backup is valid
    vi.mocked(parseJsonSafe)
      .mockReturnValueOnce({ ok: false, error: "Unexpected token" })
      .mockReturnValueOnce({
        ok: true,
        data: { ...makeStatus("restore-test"), state: "running" },
      })

    const result = loadState("restore-test", "/tmp/task-dir")

    expect(result).not.toBeNull()
    expect(result?.taskId).toBe("restore-test")
    // parseJsonSafe called twice: corrupt file, then backup
    expect(parseJsonSafe).toHaveBeenCalledTimes(2)
  })

  it("returns null when both status.json and backup are corrupt", () => {
    vi.mocked(parseJsonSafe).mockReturnValue({ ok: false, error: "Unexpected token" })

    const result = loadState("both-corrupt", "/tmp/task-dir")

    expect(result).toBeNull()
  })

  it("returns null when taskId in file doesn't match", () => {
    vi.mocked(parseJsonSafe).mockReturnValueOnce({
      ok: true,
      data: { ...makeStatus("other-task"), taskId: "other-task" },
    })

    const result = loadState("my-task", "/tmp/task-dir")

    expect(result).toBeNull()
  })
})
