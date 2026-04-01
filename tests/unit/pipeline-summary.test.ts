import { describe, it, expect } from "vitest"
import { formatPipelineSummary } from "../../src/pipeline/summary.js"
import type { PipelineStatus } from "../../src/types.js"

function makeState(overrides?: Partial<PipelineStatus>): PipelineStatus {
  return {
    taskId: "42-260401-120000",
    state: "completed",
    createdAt: "2026-04-01T12:00:00.000Z",
    updatedAt: "2026-04-01T12:05:32.000Z",
    stages: {
      taskify: { state: "completed", startedAt: "2026-04-01T12:00:00.000Z", completedAt: "2026-04-01T12:00:45.000Z", retries: 0 },
      plan: { state: "completed", startedAt: "2026-04-01T12:00:45.000Z", completedAt: "2026-04-01T12:01:30.000Z", retries: 0 },
      build: { state: "completed", startedAt: "2026-04-01T12:01:30.000Z", completedAt: "2026-04-01T12:03:30.000Z", retries: 1 },
      verify: { state: "completed", startedAt: "2026-04-01T12:03:30.000Z", completedAt: "2026-04-01T12:04:00.000Z", retries: 0 },
      review: { state: "completed", startedAt: "2026-04-01T12:04:00.000Z", completedAt: "2026-04-01T12:04:45.000Z", retries: 0 },
      "review-fix": { state: "completed", startedAt: "2026-04-01T12:04:45.000Z", completedAt: "2026-04-01T12:05:10.000Z", retries: 0 },
      ship: { state: "completed", startedAt: "2026-04-01T12:05:10.000Z", completedAt: "2026-04-01T12:05:32.000Z", retries: 0 },
    },
    ...overrides,
  }
}

describe("formatPipelineSummary", () => {
  it("produces markdown with task-id header", () => {
    const md = formatPipelineSummary(makeState())
    expect(md).toContain("## Pipeline Summary: `42-260401-120000`")
  })

  it("includes a stage table with header row", () => {
    const md = formatPipelineSummary(makeState())
    expect(md).toContain("| Stage | Status | Duration | Retries |")
    expect(md).toContain("|-------|--------|----------|---------|")
  })

  it("shows each stage with status icon and duration", () => {
    const md = formatPipelineSummary(makeState())
    // taskify: 45s
    expect(md).toMatch(/\| taskify\s*\|.*45s/)
    // build: 2m 0s, 1 retry
    expect(md).toMatch(/\| build\s*\|.*2m 0s.*\| 1\s*\|/)
  })

  it("shows completed stages with check icon", () => {
    const md = formatPipelineSummary(makeState())
    expect(md).toContain("completed")
  })

  it("shows failed stages with X icon", () => {
    const state = makeState({
      state: "failed",
      stages: {
        ...makeState().stages,
        build: { state: "failed", retries: 2, error: "Build broke" },
      },
    })
    const md = formatPipelineSummary(state)
    expect(md).toMatch(/\| build\s*\|.*failed/)
  })

  it("shows total duration in footer", () => {
    const md = formatPipelineSummary(makeState())
    // Total from 12:00:00 to 12:05:32 = 5m 32s
    expect(md).toContain("5m 32s")
  })

  it("includes complexity and model when provided", () => {
    const md = formatPipelineSummary(makeState(), { complexity: "low", model: "MiniMax-M2.7" })
    expect(md).toContain("low")
    expect(md).toContain("MiniMax-M2.7")
  })

  it("omits complexity and model when not provided", () => {
    const md = formatPipelineSummary(makeState())
    expect(md).not.toContain("Complexity")
    expect(md).not.toContain("Model")
  })

  it("handles stages without timing info gracefully", () => {
    const state = makeState()
    state.stages.ship = { state: "pending", retries: 0 }
    const md = formatPipelineSummary(state)
    expect(md).toMatch(/\| ship\s*\|.*pending.*\| -\s*\|/)
  })

  it("handles timed-out stages", () => {
    const state = makeState({
      state: "failed",
      stages: {
        ...makeState().stages,
        verify: { state: "timeout", retries: 2, error: "Stage timed out" },
      },
    })
    const md = formatPipelineSummary(state)
    expect(md).toMatch(/\| verify\s*\|.*timeout/)
  })
})
