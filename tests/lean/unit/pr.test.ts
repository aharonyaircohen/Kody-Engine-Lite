import { describe, it, expect } from "vitest"
import { buildPrTitle, buildPrBody } from "../../../src-v2/pr.js"

describe("pr: buildPrTitle", () => {
  it("formats issue number and title", () => {
    expect(buildPrTitle(42, "Add feature X", false)).toBe("#42: Add feature X")
  })

  it("prefixes draft with [WIP]", () => {
    expect(buildPrTitle(42, "Add X", true)).toBe("[WIP] #42: Add X")
  })

  it("truncates long titles to 72 chars", () => {
    const long = "x".repeat(200)
    const result = buildPrTitle(1, long, false)
    expect(result.length).toBeLessThanOrEqual(72)
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("pr: buildPrBody", () => {
  const baseOpts = {
    branch: "1-foo",
    defaultBranch: "main",
    issueNumber: 5,
    issueTitle: "Add Y",
    draft: false,
    changedFiles: ["src/foo.ts", "src/bar.ts"],
    cwd: ".",
  }

  it("includes Summary section and Closes #N", () => {
    const body = buildPrBody(baseOpts)
    expect(body).toMatch(/## Summary/)
    expect(body).toMatch(/Closes #5/)
  })

  it("includes Changes list with backticked file names", () => {
    const body = buildPrBody(baseOpts)
    expect(body).toMatch(/## Changes/)
    expect(body).toMatch(/`src\/foo\.ts`/)
    expect(body).toMatch(/`src\/bar\.ts`/)
  })

  it("prefixes draft body with FAILED warning", () => {
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: "tests failed" })
    expect(body.startsWith("> ⚠️ FAILED: tests failed")).toBe(true)
  })

  it("truncates failure reason to 2KB", () => {
    const huge = "x".repeat(5000)
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: huge })
    const failedLine = body.split("\n")[0]!
    expect(failedLine.length).toBeLessThan(2200)
  })

  it("omits Changes section when no files changed", () => {
    const body = buildPrBody({ ...baseOpts, changedFiles: [] })
    expect(body).not.toMatch(/## Changes/)
  })

  it("caps Changes list at 50 entries", () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`)
    const body = buildPrBody({ ...baseOpts, changedFiles: many })
    const matches = body.match(/`src\/file\d+\.ts`/g) ?? []
    expect(matches.length).toBe(50)
    expect(body).toMatch(/and 10 more/)
  })
})
