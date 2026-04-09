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

describe("runQualityGates — tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjectConfig.mockReturnValue({
      quality: {
        typecheck: "pnpm typecheck",
        lint: "",
        lintFix: "",
        formatFix: "",
        testUnit: "pnpm test",
      },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { modelMap: {} },
    })
    // Default: typecheck + test both pass; tool commands handled per-test
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("typecheck") || argStr.includes("test")) return "" as never
      return "" as never
    })
  })

  it("skips tools with no run command", () => {
    const tools = [{ name: "playwright", stages: ["verify"], setup: "", run: undefined }]
    const result = runQualityGates("/tmp/task", "/tmp/project", { tools })
    expect(result.pass).toBe(true)
    // No extra calls beyond typecheck + test
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
  })

  it("skips tools whose stages do not include 'verify'", () => {
    const tools = [{ name: "playwright", stages: ["build"], setup: "", run: "npx playwright test" }]
    const result = runQualityGates("/tmp/task", "/tmp/project", { tools })
    expect(result.pass).toBe(true)
    // Only typecheck + test (not playwright)
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
  })

  it("executes tools whose stages include 'verify' and adds to rawOutputs", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("playwright")) {
        // playwright test output
        return "Running 3 tests... ok\n✓ All tests passed" as never
      }
      return "" as never
    })

    const tools = [{ name: "playwright", stages: ["verify"], setup: "", run: "npx playwright test" }]
    const result = runQualityGates("/tmp/task", "/tmp/project", { tools })
    expect(result.pass).toBe(true)
    expect(mockExecFileSync).toHaveBeenCalledTimes(3)
  })

  it("fails the pipeline when a verify-stage tool fails", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("playwright")) {
        const err = new Error("playwright failed") as Error & { stdout: string; stderr: string; killed: boolean }
        err.stdout = "Error: Cannot find element [data-testid='submit']\nExpected: 1, Received: 0"
        err.stderr = ""
        err.killed = false
        throw err
      }
      return "" as never
    })

    const tools = [{ name: "playwright", stages: ["verify"], setup: "", run: "npx playwright test" }]
    const result = runQualityGates("/tmp/task", "/tmp/project", { tools })
    expect(result.pass).toBe(false)
    expect(result.errors.some((e) => e.includes("[playwright]"))).toBe(true)
  })

  it("fails the pipeline on tool timeout", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("playwright")) {
        const err = new Error("timeout") as Error & { stdout: string; stderr: string; killed: boolean }
        err.stdout = ""
        err.stderr = ""
        err.killed = true
        throw err
      }
      return "" as never
    })

    const tools = [{ name: "playwright", stages: ["verify"], setup: "", run: "npx playwright test" }]
    const result = runQualityGates("/tmp/task", "/tmp/project", { tools })
    expect(result.pass).toBe(false)
    expect(result.errors.some((e) => e.includes("timed out"))).toBe(true)
  })

  it("returns empty errors array when tools pass", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("playwright")) {
        return "✓ 5 tests passed" as never
      }
      return "" as never
    })

    const tools = [
      { name: "playwright", stages: ["verify"], setup: "", run: "npx playwright test" },
      { name: "vitest", stages: ["verify"], setup: "", run: "npx vitest --run" },
    ]
    const result = runQualityGates("/tmp/task", "/tmp/project", { tools })
    expect(result.pass).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("runs multiple tools in verify stage sequentially", () => {
    const calls: string[] = []
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      calls.push(argStr)
      if (argStr.includes("playwright") || argStr.includes("vitest")) return "" as never
      return "" as never
    })

    const tools = [
      { name: "playwright", stages: ["verify"], setup: "", run: "npx playwright test" },
      { name: "vitest", stages: ["verify"], setup: "", run: "npx vitest --run" },
    ]
    runQualityGates("/tmp/task", "/tmp/project", { tools })
    expect(calls.filter((c) => c.includes("playwright") || c.includes("vitest"))).toHaveLength(2)
  })
})

// Separate describe so lint can be enabled (its own beforeEach)
describe("runQualityGates — backward compat (empty tools)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjectConfig.mockReturnValue({
      quality: {
        typecheck: "pnpm typecheck",
        lint: "pnpm lint",
        lintFix: "",
        formatFix: "",
        testUnit: "pnpm test",
      },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { modelMap: {} },
    })
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("typecheck") || argStr.includes("test")) return "" as never
      const err = new Error("lint failed") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = "error"
      err.stderr = ""
      err.killed = false
      throw err
    })
  })

  it("does not affect existing gate behavior when tools is empty", () => {
    const result = runQualityGates("/tmp/task", "/tmp/project")
    expect(result.pass).toBe(false)
    expect(result.errors.some((e) => e.includes("[lint]"))).toBe(true)
  })
})

describe("runQualityGates — onlyFailOnFiles (scoped typecheck)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Config with typecheck + test, no lint
    mockGetProjectConfig.mockReturnValue({
      quality: {
        typecheck: "pnpm typecheck",
        lint: "",
        lintFix: "",
        formatFix: "",
        testUnit: "pnpm test",
      },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { modelMap: {} },
    })
    // tests always pass
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      // typecheck fails by default (overridden per-test)
      const err = new Error("typecheck failed") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = ""
      err.stderr = ""
      err.killed = false
      throw err
    })
  })

  it("passes when typecheck errors are only in non-scoped files", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      const err = new Error("typecheck failed") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = "error TS2322: Type mismatch\nsrc/utils/helpers.ts:10:5 - error TS2345: Argument mismatch"
      err.stderr = ""
      err.killed = false
      throw err
    })

    // Scoped to src/auth/auth.ts — errors are in src/utils/helpers.ts (pre-existing)
    const result = runQualityGates("/tmp/task", "/tmp/project", { onlyFailOnFiles: ["src/auth/auth.ts"] })
    expect(result.pass).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("fails when typecheck errors are in scoped (conflicted) files", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      const err = new Error("typecheck failed") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = "src/auth/auth.ts:15:3 - error TS2322: Type 'string' is not assignable to type 'number'"
      err.stderr = ""
      err.killed = false
      throw err
    })

    const result = runQualityGates("/tmp/task", "/tmp/project", { onlyFailOnFiles: ["src/auth/auth.ts"] })
    expect(result.pass).toBe(false)
    expect(result.errors.some((e) => e.includes("typecheck"))).toBe(true)
  })

  it("fails when errors are mixed (some in scoped files)", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      const err = new Error("typecheck failed") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = [
        "src/auth/auth.ts:15:3 - error TS2322: in conflicted file",
        "src/utils/helpers.ts:10:5 - error TS2345: pre-existing",
      ].join("\n")
      err.stderr = ""
      err.killed = false
      throw err
    })

    const result = runQualityGates("/tmp/task", "/tmp/project", { onlyFailOnFiles: ["src/auth/auth.ts"] })
    expect(result.pass).toBe(false)
  })

  it("behaves as before (fails on all typecheck errors) when onlyFailOnFiles is not set", () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argStr = (args as string[])?.join(" ") ?? ""
      if (argStr.includes("test")) return "" as never
      const err = new Error("typecheck failed") as Error & { stdout: string; stderr: string; killed: boolean }
      err.stdout = "src/utils/helpers.ts:10:5 - error TS2345: some error"
      err.stderr = ""
      err.killed = false
      throw err
    })

    const result = runQualityGates("/tmp/task", "/tmp/project")
    expect(result.pass).toBe(false)
  })
})
