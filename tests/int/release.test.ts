import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  parseConventionalCommits,
  bumpVersion,
  generateChangelog,
  updateChangelogFile,
  determineBumpType,
} from "../../src/bin/commands/release.js"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("Integration: release command", () => {
  describe("parseConventionalCommits", () => {
    it("parses feat commits with PR number", () => {
      const lines = ["abc123 feat(auth): add login endpoint (#42)"]
      const commits = parseConventionalCommits(lines)
      expect(commits[0].type).toBe("feat")
      expect(commits[0].scope).toBe("auth")
      expect(commits[0].subject).toBe("add login endpoint (#42)")
      expect(commits[0].prNumber).toBe(42)
      expect(commits[0].breaking).toBe(false)
    })

    it("parses fix commits", () => {
      const lines = ["def456 fix(api): handle null response"]
      const commits = parseConventionalCommits(lines)
      expect(commits[0].type).toBe("fix")
      expect(commits[0].subject).toBe("handle null response")
    })

    it("parses breaking change commits", () => {
      const lines = ["xyz789 feat!: remove legacy endpoint"]
      const commits = parseConventionalCommits(lines)
      expect(commits[0].breaking).toBe(true)
      expect(commits[0].subject).toBe("remove legacy endpoint")
    })

    it("parses chore and docs commits", () => {
      const lines = ["aaa111 chore: update dependencies", "bbb222 docs: update README"]
      const commits = parseConventionalCommits(lines)
      expect(commits[0].type).toBe("chore")
      expect(commits[1].type).toBe("docs")
    })

    it("handles unparsable lines gracefully", () => {
      const lines = ["abc1234 Merge branch 'main' into feature", "def5678 random text"]
      const commits = parseConventionalCommits(lines)
      expect(commits[0].type).toBe("other")
      expect(commits[1].type).toBe("other")
    })
  })

  describe("bumpVersion", () => {
    it("bumps patch correctly", () => {
      expect(bumpVersion("1.0.0", "patch")).toBe("1.0.1")
      expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4")
    })

    it("bumps minor correctly", () => {
      expect(bumpVersion("1.0.0", "minor")).toBe("1.1.0")
      expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0")
    })

    it("bumps major correctly", () => {
      expect(bumpVersion("1.0.0", "major")).toBe("2.0.0")
      expect(bumpVersion("2.5.3", "major")).toBe("3.0.0")
    })

    it("throws on invalid semver", () => {
      expect(() => bumpVersion("invalid", "patch")).toThrow()
      expect(() => bumpVersion("1.0", "patch")).toThrow()
    })
  })

  describe("determineBumpType", () => {
    it("returns major for breaking changes", () => {
      const commits = [{ hash: "a", type: "feat", breaking: true, subject: "" }]
      expect(determineBumpType(commits)).toBe("major")
    })

    it("returns minor for feat commits", () => {
      const commits = [{ hash: "a", type: "feat", breaking: false, subject: "" }]
      expect(determineBumpType(commits)).toBe("minor")
    })

    it("returns patch for fix commits", () => {
      const commits = [{ hash: "a", type: "fix", breaking: false, subject: "" }]
      expect(determineBumpType(commits)).toBe("patch")
    })

    it("respects override", () => {
      const commits = [{ hash: "a", type: "fix", breaking: false, subject: "" }]
      expect(determineBumpType(commits, "minor")).toBe("minor")
    })
  })

  describe("generateChangelog", () => {
    it("groups commits by type", () => {
      const commits = [
        { hash: "a", type: "feat", breaking: false, subject: "add login" },
        { hash: "b", type: "fix", breaking: false, subject: "fix null error" },
        { hash: "c", type: "docs", breaking: false, subject: "update README" },
      ]
      const changelog = generateChangelog(commits, "1.1.0", "2026-01-01")
      expect(changelog).toContain("## [1.1.0] - 2026-01-01")
      expect(changelog).toContain("### Features")
      expect(changelog).toContain("### Bug Fixes")
      expect(changelog).toContain("add login")
      expect(changelog).toContain("fix null error")
    })

    it("includes BREAKING CHANGES section", () => {
      const commits = [
        { hash: "a", type: "feat", breaking: true, subject: "remove legacy API" },
      ]
      const changelog = generateChangelog(commits, "2.0.0", "2026-01-01")
      expect(changelog).toContain("### BREAKING CHANGES")
      expect(changelog).toContain("remove legacy API")
    })

    it("includes PR numbers when present", () => {
      const commits = [
        { hash: "a", type: "feat", breaking: false, subject: "add auth (#42)" },
      ]
      const changelog = generateChangelog(commits, "1.1.0", "2026-01-01")
      expect(changelog).toContain("(#42)")
    })

    it("orders sections correctly", () => {
      const commits = [
        { hash: "a", type: "docs", breaking: false, subject: "d" },
        { hash: "b", type: "fix", breaking: false, subject: "f" },
        { hash: "c", type: "feat", breaking: false, subject: "f" },
      ]
      const changelog = generateChangelog(commits, "1.1.0", "2026-01-01")
      const featIdx = changelog.indexOf("### Features")
      const fixIdx = changelog.indexOf("### Bug Fixes")
      const docsIdx = changelog.indexOf("### Documentation")
      expect(featIdx).toBeLessThan(fixIdx)
      expect(fixIdx).toBeLessThan(docsIdx)
    })
  })

  describe("updateChangelogFile", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-release-int-"))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("creates CHANGELOG.md if it doesn't exist", () => {
      const changelogContent = "## [1.0.0] - 2026-01-01\n\n### Features\n- first feature"
      updateChangelogFile(tmpDir, changelogContent, false)
      const filePath = path.join(tmpDir, "CHANGELOG.md")
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, "utf-8")).toContain("## [1.0.0]")
    })

    it("prepends to existing CHANGELOG.md", () => {
      const existingContent = "# Changelog\n\nOld entry here."
      fs.writeFileSync(path.join(tmpDir, "CHANGELOG.md"), existingContent)

      const newContent = "## [1.1.0] - 2026-01-01\n\n### Features\n- new feature"
      updateChangelogFile(tmpDir, newContent, false)

      const content = fs.readFileSync(path.join(tmpDir, "CHANGELOG.md"), "utf-8")
      expect(content.indexOf("## [1.1.0]")).toBeLessThan(content.indexOf("Old entry"))
    })

    it("skips file writes in dry-run mode", () => {
      const changelogContent = "## [1.0.0] - 2026-01-01"
      updateChangelogFile(tmpDir, changelogContent, true)
      expect(fs.existsSync(path.join(tmpDir, "CHANGELOG.md"))).toBe(false)
    })
  })
})
