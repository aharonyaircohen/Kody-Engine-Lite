import { describe, it, expect, vi, beforeEach } from "vitest"

// We test runQualityGates indirectly by mocking execFileSync
// to control command outputs and verify rawOutputs are captured

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}))

vi.mock("../../src/config.js", () => ({
  getProjectConfig: vi.fn(),
  VERIFY_COMMAND_TIMEOUT_MS: 300_000,
}))

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { execFileSync } from "child_process"
import { getProjectConfig } from "../../src/config.js"
import { runQualityGates } from "../../src/verify-runner.js"

const mockExecFileSync = vi.mocked(execFileSync)
const mockGetProjectConfig = vi.mocked(getProjectConfig)

describe("runQualityGates rawOutputs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjectConfig.mockReturnValue({
      quality: {
        typecheck: "",
        lint: "pnpm lint",
        lintFix: "",
        formatFix: "",
        testUnit: "pnpm test",
      },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { modelMap: {} },
    })
  })

  it("includes rawOutputs for failed commands", () => {
    // test passes
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      // lint fails
      const err = new Error("lint failed") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = "src/utils/range.ts\n  24:7  error  no-unused-vars  'x' is defined but never used\n\n1 problem (1 error)"
      err.stderr = ""
      err.killed = false
      throw err
    })

    const result = runQualityGates("/tmp/task", "/tmp/project")
    expect(result.pass).toBe(false)
    expect(result.rawOutputs).toHaveLength(1)
    expect(result.rawOutputs[0].name).toBe("lint")
    expect(result.rawOutputs[0].output).toContain("no-unused-vars")
    expect(result.rawOutputs[0].output).toContain("range.ts")
  })

  it("returns empty rawOutputs when all commands pass", () => {
    mockExecFileSync.mockReturnValue("" as never)

    const result = runQualityGates("/tmp/task", "/tmp/project")
    expect(result.pass).toBe(true)
    expect(result.rawOutputs).toEqual([])
  })

  it("captures rawOutputs from multiple failing commands", () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("fail") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = "some error output"
      err.stderr = ""
      err.killed = false
      throw err
    })

    const result = runQualityGates("/tmp/task", "/tmp/project")
    expect(result.pass).toBe(false)
    expect(result.rawOutputs.length).toBeGreaterThanOrEqual(2)
  })

  it("truncates rawOutput to last 3000 chars", () => {
    const longOutput = "x".repeat(5000)
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      const err = new Error("fail") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = longOutput
      err.stderr = ""
      err.killed = false
      throw err
    })

    const result = runQualityGates("/tmp/task", "/tmp/project")
    expect(result.rawOutputs[0].output.length).toBe(3000)
  })

  it("does not add rawOutput for timed-out commands", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      // timeout
      const err = new Error("timeout") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = ""
      err.stderr = ""
      err.killed = true
      throw err
    })

    const result = runQualityGates("/tmp/task", "/tmp/project")
    expect(result.pass).toBe(false)
    expect(result.rawOutputs).toEqual([])
  })
})
