import { describe, it, expect } from "vitest"
import { formatReport } from "../../src/cli/test-model-report.js"
import type { TestReport, TestResult } from "../../src/cli/test-model-report.js"

function makeResult(overrides: Partial<TestResult> & Pick<TestResult, "name" | "category">): TestResult {
  return {
    status: "pass",
    accuracy: 100,
    durationMs: 1000,
    detail: "OK",
    ...overrides,
  }
}

const baseReport: TestReport = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  results: [],
  totalDurationMs: 5000,
  dropParamsRequired: true,
  timestamp: "2026-04-01 21:00:00",
}

describe("formatReport", () => {
  it("includes header with provider, model, and timestamp", () => {
    const report = formatReport({ ...baseReport, results: [makeResult({ name: "simple_prompt", category: "basic" })] })
    expect(report).toContain("gemini")
    expect(report).toContain("gemini-2.5-flash")
    expect(report).toContain("2026-04-01")
  })

  it("groups results by category", () => {
    const report = formatReport({
      ...baseReport,
      results: [
        makeResult({ name: "simple_prompt", category: "basic" }),
        makeResult({ name: "tool_read", category: "tool-use" }),
        makeResult({ name: "plan_stage", category: "stage-simulation" }),
      ],
    })
    expect(report).toContain("BASIC CAPABILITIES")
    expect(report).toContain("TOOL USE")
    expect(report).toContain("STAGE SIMULATION")
  })

  it("shows correct pass/fail/warn counts", () => {
    const report = formatReport({
      ...baseReport,
      results: [
        makeResult({ name: "a", category: "basic", status: "pass" }),
        makeResult({ name: "b", category: "basic", status: "fail", accuracy: 0, detail: "broken" }),
        makeResult({ name: "c", category: "basic", status: "warn", accuracy: 50 }),
      ],
    })
    expect(report).toContain("RESULTS: 1/3 PASS | 1 FAIL | 1 WARN")
  })

  it("calculates overall accuracy as average", () => {
    const report = formatReport({
      ...baseReport,
      results: [
        makeResult({ name: "a", category: "basic", accuracy: 100 }),
        makeResult({ name: "b", category: "basic", accuracy: 50 }),
      ],
    })
    expect(report).toContain("OVERALL ACCURACY: 75%")
  })

  it("shows drop_params status", () => {
    const yes = formatReport({ ...baseReport, dropParamsRequired: true, results: [makeResult({ name: "a", category: "basic" })] })
    const no = formatReport({ ...baseReport, dropParamsRequired: false, results: [makeResult({ name: "a", category: "basic" })] })
    expect(yes).toContain("drop_params required: YES")
    expect(no).toContain("drop_params required: NO")
  })

  it("shows per-category accuracy", () => {
    const report = formatReport({
      ...baseReport,
      results: [
        makeResult({ name: "a", category: "basic", accuracy: 80 }),
        makeResult({ name: "b", category: "basic", accuracy: 60 }),
        makeResult({ name: "c", category: "tool-use", accuracy: 100 }),
      ],
    })
    expect(report).toContain("BASIC CAPABILITIES")
    expect(report).toContain("70%") // avg of 80 and 60
    expect(report).toContain("TOOL USE")
    expect(report).toContain("100%")
  })

  it("shows recommendation for fully compatible model", () => {
    const report = formatReport({
      ...baseReport,
      results: [
        makeResult({ name: "plan_stage", category: "stage-simulation", accuracy: 95 }),
        makeResult({ name: "build_stage", category: "stage-simulation", accuracy: 100 }),
      ],
    })
    expect(report).toContain("Fully compatible")
  })

  it("shows recommendation with failing stages", () => {
    const report = formatReport({
      ...baseReport,
      results: [
        makeResult({ name: "plan_stage", category: "stage-simulation", status: "fail", accuracy: 20, detail: "Modified files" }),
        makeResult({ name: "build_stage", category: "stage-simulation", status: "pass", accuracy: 100 }),
        makeResult({ name: "review_stage", category: "stage-simulation", status: "pass", accuracy: 100 }),
        makeResult({ name: "simple_prompt", category: "basic", status: "pass", accuracy: 100 }),
      ],
    })
    expect(report).toContain("Suitable for: build, review")
    expect(report).toContain("Not recommended for: plan")
  })

  it("shows failure details for failed tests", () => {
    const report = formatReport({
      ...baseReport,
      results: [
        makeResult({ name: "plan_stage", category: "stage-simulation", status: "fail", accuracy: 0, detail: "Model modified files" }),
      ],
    })
    expect(report).toContain("Model modified files")
  })
})
