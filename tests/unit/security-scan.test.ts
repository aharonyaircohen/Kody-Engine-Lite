import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execSync } from "child_process"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-sec-scan-"))
}

function createSrcDir(rootDir: string): string {
  const srcDir = path.join(rootDir, "src")
  fs.mkdirSync(srcDir, { recursive: true })
  return srcDir
}

describe("security scan", () => {
  describe("scanForHardcodedSecrets", () => {
    let tmp: string

    beforeEach(() => {
      tmp = tmpDir()
    })

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it("detects AWS access key pattern", async () => {
      const { scanForHardcodedSecrets } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const srcDir = createSrcDir(tmp)
      fs.writeFileSync(
        path.join(srcDir, "config.ts"),
        `export const awsKey = "AKIAIOSFODNN7EXAMPLE"`,
      )
      const findings = scanForHardcodedSecrets(tmp)
      expect(findings.some((f) => f.rule === "hardcoded-secret" && f.file === "src/config.ts")).toBe(true)
    })

    it("detects generic API key assignment", async () => {
      const { scanForHardcodedSecrets } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const srcDir = createSrcDir(tmp)
      fs.writeFileSync(
        path.join(srcDir, "client.ts"),
        `const apiKey = "sk_test_12345678901234567890"`,
      )
      const findings = scanForHardcodedSecrets(tmp)
      expect(findings.some((f) => f.rule === "hardcoded-secret")).toBe(true)
    })

    it("detects JWT token pattern", async () => {
      const { scanForHardcodedSecrets } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const srcDir = createSrcDir(tmp)
      fs.writeFileSync(
        path.join(srcDir, "auth.ts"),
        `const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"`,
      )
      const findings = scanForHardcodedSecrets(tmp)
      expect(findings.some((f) => f.rule === "hardcoded-secret")).toBe(true)
    })

    it("returns empty for clean files", async () => {
      const { scanForHardcodedSecrets } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const srcDir = createSrcDir(tmp)
      fs.writeFileSync(path.join(srcDir, "clean.ts"), "export function greet(name: string) { return `Hello, ${name}` }")
      const findings = scanForHardcodedSecrets(tmp)
      expect(findings).toEqual([])
    })

    it("returns empty when src/ does not exist", async () => {
      const { scanForHardcodedSecrets } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const findings = scanForHardcodedSecrets(tmp)
      expect(findings).toEqual([])
    })

    it("reports correct line number for secrets", async () => {
      const { scanForHardcodedSecrets } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const srcDir = createSrcDir(tmp)
      fs.writeFileSync(
        path.join(srcDir, "config.ts"),
        `export function init() {\n  const key = "AKIAIOSFODNN7EXAMPLE"\n  return key\n}`,
      )
      const findings = scanForHardcodedSecrets(tmp)
      const finding = findings.find((f) => f.file === "src/config.ts")
      expect(finding).toBeDefined()
      expect(finding!.line).toBe(2)
    })
  })

  describe("scanForCommittedEnvFiles", () => {
    let tmp: string

    beforeEach(() => {
      tmp = tmpDir()
      // Init a git repo so ls-files can work
      execSync("git init", { cwd: tmp, stdio: "pipe" })
    })

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it("reports committed .env file as critical finding", async () => {
      const { scanForCommittedEnvFiles } = await import("../../src/watch/plugins/security-scan/scanner.js")
      fs.writeFileSync(path.join(tmp, ".env"), "API_KEY=secret")
      execSync("git add .env", { cwd: tmp, stdio: "pipe" })
      const findings = scanForCommittedEnvFiles(tmp)
      expect(findings.some((f) => f.rule === "committed-env-file" && f.file === ".env")).toBe(true)
    })

    it("returns empty when .env is not committed", async () => {
      const { scanForCommittedEnvFiles } = await import("../../src/watch/plugins/security-scan/scanner.js")
      fs.writeFileSync(path.join(tmp, ".env"), "API_KEY=secret")
      // Don't git add — file is not tracked
      const findings = scanForCommittedEnvFiles(tmp)
      expect(findings).toEqual([])
    })
  })

  describe("runAllScans", () => {
    let tmp: string

    beforeEach(() => {
      tmp = tmpDir()
    })

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it("returns sorted findings by severity", async () => {
      const { runAllScans } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const srcDir = createSrcDir(tmp)
      // Critical: hardcoded secret
      fs.writeFileSync(path.join(srcDir, "config.ts"), `const key = "AKIAIOSFODNN7EXAMPLE"`)
      const findings = runAllScans(tmp)
      // First finding should be critical (hardcoded-secret or committed-env-file)
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].severity).toBe("critical")
    })

    it("returns empty when project is clean", async () => {
      const { runAllScans } = await import("../../src/watch/plugins/security-scan/scanner.js")
      const srcDir = createSrcDir(tmp)
      fs.writeFileSync(path.join(srcDir, "index.ts"), "export const x = 1")
      const findings = runAllScans(tmp)
      // No secrets in clean file; no committed env files
      const secretFindings = findings.filter((f) => f.rule === "hardcoded-secret")
      const envFindings = findings.filter((f) => f.rule === "committed-env-file")
      expect(secretFindings).toEqual([])
      expect(envFindings).toEqual([])
    })
  })
})
