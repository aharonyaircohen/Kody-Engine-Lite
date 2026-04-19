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

  it("prefixes draft body with single-line headline + pre-existing-warning", () => {
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: "verify failed: typecheck" })
    expect(body.startsWith("> ⚠️ Draft: verify failed: typecheck\n")).toBe(true)
    expect(body).toMatch(/pre-existing/)
  })

  it("hides multi-line failure reason in a collapsible details block", () => {
    const huge = "verify failed: typecheck\n" + "ERROR ".repeat(2000)
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: huge })
    const headline = body.split("\n")[0]!
    expect(headline.length).toBeLessThan(220)
    expect(body).toMatch(/<details>/)
    expect(body).toMatch(/Verify output \(click to expand\)/)
    expect(body).toMatch(/<\/details>/)
  })

  it("places Summary and Closes #N before any details block", () => {
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: "verify failed: lint" })
    const summaryIdx = body.indexOf("## Summary")
    const closesIdx = body.indexOf("Closes #")
    const detailsIdx = body.indexOf("<details>")
    expect(summaryIdx).toBeLessThan(detailsIdx)
    expect(closesIdx).toBeLessThan(detailsIdx)
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
