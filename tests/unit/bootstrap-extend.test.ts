import { describe, it, expect } from "vitest"
import { buildExtendInstruction } from "../../src/bin/extend-helpers.js"

// ─── Extend Helper ────────────────────────────────────────────────────────────

describe("buildExtendInstruction", () => {
  it("returns empty string when no existing content", () => {
    const result = buildExtendInstruction("", "step file")
    expect(result).toBe("")
  })

  it("returns extend instructions when existing content provided", () => {
    const existing = "# Build\n\n## Repo Patterns\n- OAuth handler pattern\n"
    const result = buildExtendInstruction(existing, "step file")
    expect(result).toContain("EXTEND")
    expect(result).toContain("PRESERVE")
    expect(result).toContain(existing)
  })

  it("includes the file description in instructions", () => {
    const result = buildExtendInstruction("# content", "QA guide")
    expect(result).toContain("QA guide")
  })

  it("instructs to remove stale references", () => {
    const result = buildExtendInstruction("# content", "step file")
    expect(result).toMatch(/remove|stale|no longer exist/i)
  })

  it("instructs to preserve manual edits", () => {
    const result = buildExtendInstruction("# content", "step file")
    expect(result).toMatch(/preserve|manual|verbatim/i)
  })
})
