/**
 * W-B — citation extraction from LLM output.
 */

import { describe, it, expect } from "vitest"

describe("extractCitations", () => {
  it("extracts a single [fact_*] citation", async () => {
    const { extractCitations } = await import("../../src/memory/graph/citation.js")
    const text = "Based on [fact_conventions_auth_12345], we should use sessions."
    expect(extractCitations(text)).toEqual(["fact_conventions_auth_12345"])
  })

  it("extracts multiple citations, deduped, first-occurrence order", async () => {
    const { extractCitations } = await import("../../src/memory/graph/citation.js")
    const text =
      "We'll honor [fact_facts_testing_1] and [fact_conventions_api_2]. " +
      "Since [fact_facts_testing_1] says Vitest, and [fact_thoughts_perf_3] recommends async."
    expect(extractCitations(text)).toEqual([
      "fact_facts_testing_1",
      "fact_conventions_api_2",
      "fact_thoughts_perf_3",
    ])
  })

  it("returns empty for no citations", async () => {
    const { extractCitations } = await import("../../src/memory/graph/citation.js")
    expect(extractCitations("no citations here")).toEqual([])
  })

  it("handles empty / null / undefined input", async () => {
    const { extractCitations } = await import("../../src/memory/graph/citation.js")
    expect(extractCitations("")).toEqual([])
    expect(extractCitations(null)).toEqual([])
    expect(extractCitations(undefined)).toEqual([])
  })

  it("ignores non-fact bracketed tokens", async () => {
    const { extractCitations } = await import("../../src/memory/graph/citation.js")
    expect(extractCitations("See [todo] or [x] but [fact_a_1] counts")).toEqual(["fact_a_1"])
  })

  it("CITATION_INSTRUCTION is a non-empty string", async () => {
    const { CITATION_INSTRUCTION } = await import("../../src/memory/graph/citation.js")
    expect(typeof CITATION_INSTRUCTION).toBe("string")
    expect(CITATION_INSTRUCTION.length).toBeGreaterThan(20)
  })
})
