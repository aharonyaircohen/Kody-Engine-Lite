import { describe, it, expect, vi } from "vitest"
import { resolveActivityLog, type ActivityLogGateway } from "../../src/bin/commands/bootstrap.js"

function makeGateway(overrides: Partial<ActivityLogGateway> = {}): ActivityLogGateway {
  return {
    getIssueState: vi.fn(() => "OPEN"),
    getVariable: vi.fn(() => null),
    searchIssue: vi.fn(() => null),
    createIssue: vi.fn(() => null),
    pinIssue: vi.fn(),
    ...overrides,
  }
}

describe("resolveActivityLog", () => {
  it("uses config value when issue is open", () => {
    const gw = makeGateway()
    const result = resolveActivityLog(42, gw)
    expect(result.issueNumber).toBe(42)
    expect(result.source).toBe("config")
    expect(result.warnings).toHaveLength(0)
    expect(gw.getVariable).not.toHaveBeenCalled()
    expect(gw.searchIssue).not.toHaveBeenCalled()
    expect(gw.createIssue).not.toHaveBeenCalled()
  })

  it("warns and falls through when config issue is closed", () => {
    const gw = makeGateway({
      getIssueState: vi.fn((n) => n === 42 ? "CLOSED" : "OPEN"),
      getVariable: vi.fn(() => null),
      searchIssue: vi.fn(() => 99),
    })
    const result = resolveActivityLog(42, gw)
    expect(result.issueNumber).toBe(99)
    expect(result.source).toBe("search")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("#42")
    expect(result.warnings[0]).toContain("CLOSED")
  })

  it("warns and falls through when config issue does not exist", () => {
    const gw = makeGateway({
      getIssueState: vi.fn(() => { throw new Error("not found") }),
      getVariable: vi.fn(() => null),
      createIssue: vi.fn(() => 100),
    })
    const result = resolveActivityLog(42, gw)
    expect(result.issueNumber).toBe(100)
    expect(result.source).toBe("created")
    expect(result.warnings.some(w => w.includes("#42"))).toBe(true)
  })

  it("uses variable when config is not set", () => {
    const gw = makeGateway({
      getVariable: vi.fn(() => "55"),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBe(55)
    expect(result.source).toBe("variable")
  })

  it("warns and falls through when variable issue is closed", () => {
    const gw = makeGateway({
      getIssueState: vi.fn(() => "CLOSED"),
      getVariable: vi.fn(() => "55"),
      searchIssue: vi.fn(() => 77),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBe(77)
    expect(result.source).toBe("search")
    expect(result.warnings.some(w => w.includes("#55"))).toBe(true)
  })

  it("warns and falls through when variable issue does not exist", () => {
    const gw = makeGateway({
      getIssueState: vi.fn(() => { throw new Error("not found") }),
      getVariable: vi.fn(() => "55"),
      createIssue: vi.fn(() => 200),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBe(200)
    expect(result.source).toBe("created")
    expect(result.warnings.some(w => w.includes("#55"))).toBe(true)
  })

  it("uses search result when config and variable are both unset", () => {
    const gw = makeGateway({
      getVariable: vi.fn(() => null),
      searchIssue: vi.fn(() => 88),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBe(88)
    expect(result.source).toBe("search")
  })

  it("creates issue when all sources fail", () => {
    const gw = makeGateway({
      getVariable: vi.fn(() => null),
      searchIssue: vi.fn(() => null),
      createIssue: vi.fn(() => 101),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBe(101)
    expect(result.source).toBe("created")
    expect(gw.pinIssue).toHaveBeenCalledWith(101)
  })

  it("pins newly created issue", () => {
    const pinIssue = vi.fn()
    const gw = makeGateway({
      getVariable: vi.fn(() => null),
      searchIssue: vi.fn(() => null),
      createIssue: vi.fn(() => 50),
      pinIssue,
    })
    resolveActivityLog(undefined, gw)
    expect(pinIssue).toHaveBeenCalledWith(50)
  })

  it("does not pin issues found from config/variable/search", () => {
    const pinIssue = vi.fn()
    const gw = makeGateway({ pinIssue })
    resolveActivityLog(42, gw)
    expect(pinIssue).not.toHaveBeenCalled()
  })

  it("returns null when all sources fail including create", () => {
    const gw = makeGateway({
      getVariable: vi.fn(() => null),
      searchIssue: vi.fn(() => null),
      createIssue: vi.fn(() => null),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBeNull()
    expect(result.source).toBeNull()
  })

  it("ignores non-numeric variable value", () => {
    const gw = makeGateway({
      getVariable: vi.fn(() => "not-a-number"),
      searchIssue: vi.fn(() => 33),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBe(33)
    expect(result.source).toBe("search")
  })

  it("ignores empty variable value", () => {
    const gw = makeGateway({
      getVariable: vi.fn(() => ""),
      searchIssue: vi.fn(() => 44),
    })
    const result = resolveActivityLog(undefined, gw)
    expect(result.issueNumber).toBe(44)
    expect(result.source).toBe("search")
  })

  it("skips config check when configActivityLog is 0", () => {
    const gw = makeGateway({
      getVariable: vi.fn(() => "66"),
    })
    const result = resolveActivityLog(0 as unknown as undefined, gw)
    expect(result.issueNumber).toBe(66)
    expect(result.source).toBe("variable")
  })

  it("full fallthrough: config closed → variable missing → search empty → create", () => {
    const getIssueState = vi.fn()
      .mockReturnValueOnce("CLOSED")  // config #10
      .mockImplementationOnce(() => { throw new Error("not found") })  // variable #20
    const gw = makeGateway({
      getIssueState,
      getVariable: vi.fn(() => "20"),
      searchIssue: vi.fn(() => null),
      createIssue: vi.fn(() => 300),
    })
    const result = resolveActivityLog(10, gw)
    expect(result.issueNumber).toBe(300)
    expect(result.source).toBe("created")
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain("#10")
    expect(result.warnings[1]).toContain("#20")
  })
})
