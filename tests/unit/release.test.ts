import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  parseConventionalCommits,
  determineBumpType,
  bumpVersion,
  generateChangelog,
  getCurrentVersion,
  updateVersionFiles,
  getReleaseConfig,
  type ConventionalCommit,
} from "../../src/bin/commands/release.js"
import type { KodyConfig } from "../../src/config.js"

// ─── parseConventionalCommits ───────────────────────────────────────────────

describe("parseConventionalCommits", () => {
  it("parses standard conventional commits", () => {
    const lines = [
      "abc1234 feat: add new search API",
      "def5678 fix: resolve null pointer in auth",
    ]
    const result = parseConventionalCommits(lines)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      hash: "abc1234",
      type: "feat",
      scope: undefined,
      breaking: false,
      subject: "add new search API",
      prNumber: undefined,
    })
    expect(result[1].type).toBe("fix")
  })

  it("detects breaking change from ! suffix", () => {
    const lines = ["abc1234 feat!: remove deprecated API"]
    const result = parseConventionalCommits(lines)
    expect(result[0].breaking).toBe(true)
    expect(result[0].type).toBe("feat")
  })

  it("extracts scope from parentheses", () => {
    const lines = ["abc1234 fix(auth): handle expired tokens"]
    const result = parseConventionalCommits(lines)
    expect(result[0].scope).toBe("auth")
    expect(result[0].subject).toBe("handle expired tokens")
  })

  it("extracts PR number from subject", () => {
    const lines = ["abc1234 feat: add search (#42)"]
    const result = parseConventionalCommits(lines)
    expect(result[0].prNumber).toBe(42)
  })

  it("handles non-conventional commits", () => {
    const lines = ["abc1234 Update README"]
    const result = parseConventionalCommits(lines)
    expect(result[0].type).toBe("other")
    expect(result[0].subject).toBe("Update README")
    expect(result[0].breaking).toBe(false)
  })

  it("handles empty input", () => {
    expect(parseConventionalCommits([])).toEqual([])
  })

  it("handles scoped breaking change with PR number", () => {
    const lines = ["abc1234 feat(api)!: redesign endpoints (#99)"]
    const result = parseConventionalCommits(lines)
    expect(result[0]).toEqual({
      hash: "abc1234",
      type: "feat",
      scope: "api",
      breaking: true,
      subject: "redesign endpoints (#99)",
      prNumber: 99,
    })
  })
})

// ─── determineBumpType ──────────────────────────────────────────────────────

describe("determineBumpType", () => {
  it("returns major when breaking change present", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "feat", breaking: true, subject: "breaking" },
    ]
    expect(determineBumpType(commits)).toBe("major")
  })

  it("returns minor when feat commits present", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "feat", breaking: false, subject: "new feature" },
      { hash: "b", type: "fix", breaking: false, subject: "a fix" },
    ]
    expect(determineBumpType(commits)).toBe("minor")
  })

  it("returns patch for fix-only commits", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "fix", breaking: false, subject: "bug fix" },
      { hash: "b", type: "chore", breaking: false, subject: "cleanup" },
    ]
    expect(determineBumpType(commits)).toBe("patch")
  })

  it("respects explicit override", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "feat", breaking: true, subject: "breaking" },
    ]
    expect(determineBumpType(commits, "patch")).toBe("patch")
  })

  it("defaults to patch for non-conventional commits", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "other", breaking: false, subject: "random change" },
    ]
    expect(determineBumpType(commits)).toBe("patch")
  })
})

// ─── bumpVersion ────────────────────────────────────────────────────────────

describe("bumpVersion", () => {
  it("bumps major: 1.2.3 → 2.0.0", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0")
  })

  it("bumps minor: 1.2.3 → 1.3.0", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0")
  })

  it("bumps patch: 1.2.3 → 1.2.4", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4")
  })

  it("handles 0.x versions", () => {
    expect(bumpVersion("0.1.27", "patch")).toBe("0.1.28")
    expect(bumpVersion("0.1.27", "minor")).toBe("0.2.0")
    expect(bumpVersion("0.1.27", "major")).toBe("1.0.0")
  })

  it("throws for invalid semver", () => {
    expect(() => bumpVersion("not.a.version", "patch")).toThrow("Invalid semver")
    expect(() => bumpVersion("1.2", "patch")).toThrow("Invalid semver")
  })
})

// ─── generateChangelog ──────────────────────────────────────────────────────

describe("generateChangelog", () => {
  it("groups commits by type with correct headings", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "feat", breaking: false, subject: "add search" },
      { hash: "b", type: "fix", breaking: false, subject: "fix crash" },
      { hash: "c", type: "feat", breaking: false, subject: "add filters" },
    ]
    const result = generateChangelog(commits, "1.0.0", "2026-04-05")
    expect(result).toContain("## [1.0.0] - 2026-04-05")
    expect(result).toContain("### Features")
    expect(result).toContain("### Bug Fixes")
    expect(result).toContain("- add search")
    expect(result).toContain("- fix crash")
  })

  it("puts breaking changes in prominent section", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "feat", breaking: true, subject: "remove old API" },
    ]
    const result = generateChangelog(commits, "2.0.0", "2026-04-05")
    expect(result).toContain("### BREAKING CHANGES")
    expect(result).toContain("- remove old API (a)")
  })

  it("includes PR numbers", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "feat", breaking: false, subject: "add thing", prNumber: 42 },
    ]
    const result = generateChangelog(commits, "1.1.0", "2026-04-05")
    expect(result).toContain("(#42)")
  })

  it("includes scope", () => {
    const commits: ConventionalCommit[] = [
      { hash: "a", type: "fix", scope: "auth", breaking: false, subject: "fix token" },
    ]
    const result = generateChangelog(commits, "1.0.1", "2026-04-05")
    expect(result).toContain("**auth:**")
  })

  it("handles empty commit list", () => {
    const result = generateChangelog([], "1.0.0", "2026-04-05")
    expect(result).toContain("## [1.0.0] - 2026-04-05")
  })
})

// ─── getCurrentVersion ──────────────────────────────────────────────────────

describe("getCurrentVersion", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-release-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reads version from package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.2.3" }),
    )
    expect(getCurrentVersion(tmpDir, ["package.json"])).toBe("1.2.3")
  })

  it("reads version from generic text file", () => {
    fs.writeFileSync(path.join(tmpDir, "version.txt"), 'version = "4.5.6"\n')
    expect(getCurrentVersion(tmpDir, ["version.txt"])).toBe("4.5.6")
  })

  it("throws when no version found", () => {
    expect(() => getCurrentVersion(tmpDir, ["nonexistent.json"])).toThrow("No version found")
  })
})

// ─── updateVersionFiles ─────────────────────────────────────────────────────

describe("updateVersionFiles", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-release-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("updates version in package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" }, null, 2) + "\n",
    )
    const updated = updateVersionFiles(tmpDir, ["package.json"], "1.0.0", "1.1.0", false)
    expect(updated).toEqual(["package.json"])

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"))
    expect(content.version).toBe("1.1.0")
  })

  it("skips update in dry-run mode", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" }, null, 2) + "\n",
    )
    const updated = updateVersionFiles(tmpDir, ["package.json"], "1.0.0", "1.1.0", true)
    expect(updated).toEqual(["package.json"])

    // File should not have changed
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"))
    expect(content.version).toBe("1.0.0")
  })

  it("handles missing files gracefully", () => {
    const updated = updateVersionFiles(tmpDir, ["nonexistent.json"], "1.0.0", "1.1.0", false)
    expect(updated).toEqual([])
  })
})

// ─── getReleaseConfig ───────────────────────────────────────────────────────

describe("getReleaseConfig", () => {
  const baseConfig: KodyConfig = {
    quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "test", repo: "test" },
    agent: { modelMap: {} },
  }

  it("returns defaults when no release config", () => {
    const rc = getReleaseConfig(baseConfig)
    expect(rc.versionFiles).toEqual(["package.json"])
    expect(rc.publishCommand).toBe("")
    expect(rc.notifyCommand).toBe("")
    expect(rc.releaseBranch).toBe("main")
    expect(rc.labels).toEqual(["kody:release"])
    expect(rc.draftRelease).toBe(false)
  })

  it("merges user config with defaults", () => {
    const config: KodyConfig = {
      ...baseConfig,
      release: {
        publishCommand: "npm publish",
        releaseBranch: "production",
      },
    }
    const rc = getReleaseConfig(config)
    expect(rc.publishCommand).toBe("npm publish")
    expect(rc.releaseBranch).toBe("production")
    expect(rc.versionFiles).toEqual(["package.json"]) // default preserved
  })

  it("uses defaultBranch as releaseBranch fallback", () => {
    const config: KodyConfig = {
      ...baseConfig,
      git: { defaultBranch: "dev" },
    }
    const rc = getReleaseConfig(config)
    expect(rc.releaseBranch).toBe("dev")
  })
})
