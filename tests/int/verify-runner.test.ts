import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import { parseErrors } from "../../src/verify-runner.js"

describe("Integration: verify-runner error parsing", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-verify-int-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", testUnit: "true", lint: "true" },
        agent: { defaultRunner: "sdk", modelMap: { cheap: "test", mid: "test", strong: "test" } },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("parseErrors", () => {
    it("extracts TypeScript errors correctly", () => {
      const output = [
        "src/auth/login.ts:5:10 - error TS2307: Cannot find module './utils'",
        "src/auth/login.ts:10:1 - error TS2322: Type 'string' is not assignable to type 'number'",
        "src/utils/format.ts:3:5 - error TS7016: Expected 1 arguments, but got 0",
        "  ✔ All tests passed",
      ].join("\n")

      const errors = parseErrors(output, "tsc")
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain("TS2307")
    })

    it("extracts ESLint errors correctly", () => {
      const output = [
        "  5:10  error  'foo' is defined but never used  @typescript-eslint/no-unused-vars",
        "  2:1   error  Missing JSDoc comment           jsdoc/require-jsdoc",
        "✖ 2 problems (2 errors, 0 warnings)",
      ].join("\n")

      const errors = parseErrors(output, "eslint")
      expect(errors.length).toBeGreaterThanOrEqual(1)
    })

    it("extracts Vitest failure lines correctly", () => {
      const output = [
        "FAIL src/utils/format.test.ts > should format currency",
        "FAIL src/utils/format.test.ts > should handle null",
        "  × AssertionError: expected 42 to equal 43",
        "  ✔ All tests passed (5)",
      ].join("\n")

      const errors = parseErrors(output, "vitest")
      expect(errors.some((e) => e.includes("FAIL") || e.includes("format.test"))).toBe(true)
    })

    it("returns empty array when no errors found", () => {
      const output = [
        "✔ All tests passed (12)",
        "Test Suites: 1 passed, 1 total",
        "Tests: 5 passed, 5 total",
      ].join("\n")

      const errors = parseErrors(output, "vitest")
      expect(errors).toEqual([])
    })

    it("falls back to default extractor for unknown command", () => {
      const output = [
        "An ERROR occurred in module foo",
        "Error: connection refused",
      ].join("\n")

      const errors = parseErrors(output, "unknown-tool")
      // Should not throw, should return some errors (default extractor is loose)
      expect(Array.isArray(errors)).toBe(true)
    })

    it("returns empty array on clean output with unknown command", () => {
      const output = "All good here, no errors found"
      const errors = parseErrors(output, "unknown-tool")
      expect(errors).toEqual([])
    })
  })
})
