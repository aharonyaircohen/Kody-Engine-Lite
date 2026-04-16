import { describe, it, expect } from "vitest"

describe("fix-ci-trigger pure logic", () => {
  // Mirrors the isRecent logic from fix-ci-trigger.ts
  function isRecent(createdAt: string, hours: number): boolean {
    const created = new Date(createdAt).getTime()
    const cutoff = Date.now() - hours * 60 * 60 * 1000
    return created > cutoff
  }

  // Mirrors the fix-ci detection from fix-ci-trigger.ts
  function hasRecentFixCiComment(comments: Array<{ body: string; created_at: string }>, hours: number): boolean {
    return comments.some(
      (c) => c.body?.includes("@kody fix-ci") && isRecent(c.created_at, hours),
    )
  }

  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()

  describe("isRecent", () => {
    it("returns true for comment from 1 hour ago (within 24h)", () => {
      expect(isRecent(oneHourAgo, 24)).toBe(true)
    })

    it("returns false for comment from 2 days ago (outside 24h)", () => {
      expect(isRecent(twoDaysAgo, 24)).toBe(false)
    })
  })

  describe("hasRecentFixCiComment", () => {
    it("returns true when @kody fix-ci comment is recent", () => {
      const comments = [{ body: "@kody fix-ci", created_at: oneHourAgo }]
      expect(hasRecentFixCiComment(comments, 24)).toBe(true)
    })

    it("returns false when fix-ci comment is older than 24h", () => {
      const comments = [{ body: "@kody fix-ci", created_at: twoDaysAgo }]
      expect(hasRecentFixCiComment(comments, 24)).toBe(false)
    })

    it("returns false when no fix-ci comment exists", () => {
      const comments = [{ body: "LGTM!", created_at: oneHourAgo }]
      expect(hasRecentFixCiComment(comments, 24)).toBe(false)
    })

    it("returns false for empty comments array", () => {
      expect(hasRecentFixCiComment([], 24)).toBe(false)
    })
  })
})
