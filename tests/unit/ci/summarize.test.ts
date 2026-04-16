import { describe, it, expect } from "vitest"
import { summarizeTask, type TaskStatus } from "../../../src/ci/summarize.js"

describe("summarizeTask", () => {
  it("renders completed state with correct icon", () => {
    const status: TaskStatus = {
      state: "completed",
      stages: {},
    }
    const result = summarizeTask("test-task-123", status)
    expect(result).toContain("✅")
    expect(result).toContain("completed")
    expect(result).toContain("`test-task-123`")
  })

  it("renders failed state with correct icon", () => {
    const status: TaskStatus = {
      state: "failed",
      stages: {},
    }
    const result = summarizeTask("test-task-456", status)
    expect(result).toContain("❌")
    expect(result).toContain("failed")
  })

  it("renders all 7 stages in table", () => {
    const status: TaskStatus = {
      state: "completed",
      stages: {},
    }
    const result = summarizeTask("abc", status)
    expect(result).toContain("| Stage | State |")
    expect(result).toContain("| taskify     |")
    expect(result).toContain("| plan        |")
    expect(result).toContain("| build       |")
    expect(result).toContain("| verify      |")
    expect(result).toContain("| review      |")
    expect(result).toContain("| review-fix  |")
    expect(result).toContain("| ship        |")
  })

  it("shows completed stage with check icon", () => {
    const status: TaskStatus = {
      state: "completed",
      stages: { taskify: { state: "completed" } },
    }
    const result = summarizeTask("abc", status)
    expect(result).toContain("| taskify     | ✅ completed |")
  })

  it("shows failed stage with X icon", () => {
    const status: TaskStatus = {
      state: "failed",
      stages: { build: { state: "failed" } },
    }
    const result = summarizeTask("abc", status)
    expect(result).toContain("| build       | ❌ failed |")
  })

  it("shows running stage with play icon", () => {
    const status: TaskStatus = {
      state: "running",
      stages: { plan: { state: "running" } },
    }
    const result = summarizeTask("abc", status)
    expect(result).toContain("| plan        | ▶️ running |")
  })

  it("shows timeout stage with clock icon", () => {
    const status: TaskStatus = {
      state: "failed",
      stages: { verify: { state: "timeout" } },
    }
    const result = summarizeTask("abc", status)
    expect(result).toContain("| verify      | ⏱ timeout |")
  })

  it("shows missing stage as dash", () => {
    const status: TaskStatus = {
      state: "running",
      stages: {},
    }
    const result = summarizeTask("abc", status)
    expect(result).toContain("| taskify     | ○ — |")
  })
})
