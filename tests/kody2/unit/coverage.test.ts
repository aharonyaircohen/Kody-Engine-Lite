import { describe, it, expect } from "vitest"
import {
  patternToRegex,
  renderSiblingPath,
  checkCoverage,
  formatMissesForFeedback,
} from "../../../src-v2/coverage.js"

describe("coverage: patternToRegex", () => {
  it("matches ** across path segments", () => {
    const re = patternToRegex("src/app/api/**/route.ts")
    expect(re.test("src/app/api/x/route.ts")).toBe(true)
    expect(re.test("src/app/api/a/b/c/route.ts")).toBe(true)
    expect(re.test("src/app/api/route.ts")).toBe(true)
  })
  it("matches * within a single segment only", () => {
    const re = patternToRegex("src/*.ts")
    expect(re.test("src/foo.ts")).toBe(true)
    expect(re.test("src/foo/bar.ts")).toBe(false)
  })
  it("escapes regex meta characters", () => {
    const re = patternToRegex("a.b/file.ts")
    expect(re.test("a.b/file.ts")).toBe(true)
    expect(re.test("aXb/file.ts")).toBe(false)
  })
})

describe("coverage: renderSiblingPath", () => {
  it("expands {name} and {ext}", () => {
    expect(renderSiblingPath("src/app/api/x/route.ts", "{name}.test{ext}"))
      .toBe("src/app/api/x/route.test.ts")
  })
  it("handles literal sibling names", () => {
    expect(renderSiblingPath("src/app/api/x/route.ts", "route.test.ts"))
      .toBe("src/app/api/x/route.test.ts")
  })
  it("works for files at the root", () => {
    expect(renderSiblingPath("foo.ts", "{name}.test.ts")).toBe("foo.test.ts")
  })
})

describe("coverage: checkCoverage", () => {
  const reqs = [{ pattern: "src/app/api/**/route.ts", requireSibling: "{name}.test{ext}" }]

  it("returns no misses when no requirements configured", () => {
    expect(checkCoverage(["src/app/api/x/route.ts"], [])).toEqual([])
  })

  it("flags a route added without its sibling test", () => {
    const misses = checkCoverage(["src/app/api/x/route.ts"], reqs)
    expect(misses).toEqual([{ file: "src/app/api/x/route.ts", expectedTest: "src/app/api/x/route.test.ts" }])
  })

  it("passes when the sibling test is also added", () => {
    const misses = checkCoverage(
      ["src/app/api/x/route.ts", "src/app/api/x/route.test.ts"],
      reqs,
    )
    expect(misses).toEqual([])
  })

  it("ignores files that are themselves tests", () => {
    expect(checkCoverage(["src/foo.test.ts"], [{ pattern: "src/**/*.ts", requireSibling: "{name}.test.ts" }]))
      .toEqual([])
  })

  it("flags multiple misses across requirements", () => {
    const multi = [
      { pattern: "src/app/api/**/route.ts", requireSibling: "{name}.test{ext}" },
      { pattern: "src/services/*.ts", requireSibling: "{name}.test{ext}" },
    ]
    const misses = checkCoverage(
      ["src/app/api/x/route.ts", "src/services/foo.ts"],
      multi,
    )
    expect(misses).toHaveLength(2)
  })
})

describe("coverage: formatMissesForFeedback", () => {
  it("returns empty string for empty misses", () => {
    expect(formatMissesForFeedback([])).toBe("")
  })
  it("includes file + expected test path for each miss", () => {
    const out = formatMissesForFeedback([
      { file: "a.ts", expectedTest: "a.test.ts" },
      { file: "b.ts", expectedTest: "b.test.ts" },
    ])
    expect(out).toMatch(/`a\.ts`/)
    expect(out).toMatch(/`a\.test\.ts`/)
    expect(out).toMatch(/`b\.test\.ts`/)
    expect(out).toMatch(/Add the missing test files/)
  })
})
