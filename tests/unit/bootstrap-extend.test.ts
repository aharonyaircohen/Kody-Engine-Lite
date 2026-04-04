import { describe, it, expect } from "vitest"
import { buildExtendInstruction } from "../../src/bin/extend-helpers.js"

// ─── Extend Helper ────────────────────────────────────────────────────────────

describe("buildExtendInstruction", () => {
  it("returns empty string when no existing content", () => {
    const result = buildExtendInstruction("", "step file")
    expect(result).toBe("")
  })

  it("returns extend instructions when existing content is substantial", () => {
    const existing = "# Build\n\n## Repo Patterns\n- OAuth handler pattern using passport.js with Google and GitHub providers\n- Session management via express-session with Redis store\n- All routes protected by auth middleware that checks JWT tokens\n- Error handling uses structured AppError class with HTTP status codes\n"
    const result = buildExtendInstruction(existing, "step file")
    expect(result).toContain("EXTEND")
    expect(result).toContain("PRESERVE")
    expect(result).toContain("OAuth handler pattern")
  })

  it("returns empty for short content (fallback templates)", () => {
    const result = buildExtendInstruction("# QA Guide\n\n<!-- template -->\n", "QA guide")
    expect(result).toBe("")
  })

  it("returns empty for stub content below threshold", () => {
    const result = buildExtendInstruction("# content\nsome short note", "step file")
    expect(result).toBe("")
  })

  it("includes the file description in instructions when content is substantial", () => {
    const existing = "# QA Guide\n\n## Quick Reference\nDev server: pnpm dev at http://localhost:3000\nLogin page: /admin/login\nAdmin panel: /admin\n\n## Authentication\nThe application uses Payload CMS built-in authentication with JWT tokens stored in cookies. Test accounts should be created via seed scripts. Admin users have full CRUD access to all collections. Editor users can create and edit content but cannot manage users or system settings. Viewer users have read-only access to published content only.\n"
    const result = buildExtendInstruction(existing, "QA guide")
    expect(result).toContain("QA guide")
  })

  it("instructs to remove stale references for substantial content", () => {
    const existing = "# Architecture\n\n## Framework\nNext.js 15 with App Router\nPayload CMS 3.x with PostgreSQL adapter\nTailwind CSS 4 for styling\n\n## Directory Structure\nsrc/core/ - shared infrastructure\nsrc/features/ - feature plugins\nsrc/collections/ - Payload collections\n"
    const result = buildExtendInstruction(existing, "step file")
    expect(result).toMatch(/remove|stale|no longer exist/i)
  })

  it("instructs to preserve manual edits for substantial content", () => {
    const existing = "# Conventions\n\n## Code Style\n- Immutable data patterns using spread operator\n- Pure functions where possible\n- Error boundaries via Promise.allSettled\n- Structured error types with AppError class\n\n## Testing\n- Unit tests for all core modules\n- Integration tests against PostgreSQL\n"
    const result = buildExtendInstruction(existing, "step file")
    expect(result).toMatch(/preserve|manual|verbatim/i)
  })
})
