import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { cleanupIdeSkillDirs } from "../../src/bin/commands/bootstrap.js"

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-cleanup-ide-"))
}

/** Create a fake IDE skill stub: .ide-name/skills/some-skill -> symlink */
function createIdeSkillDir(dir: string, ideName: string): void {
  const ideDir = path.join(dir, ideName, "skills")
  fs.mkdirSync(ideDir, { recursive: true })
  fs.writeFileSync(path.join(ideDir, "some-skill"), "placeholder")
}

describe("cleanupIdeSkillDirs", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it("removes IDE skill stub directories", () => {
    createIdeSkillDir(tmpDir, ".windsurf")
    createIdeSkillDir(tmpDir, ".cursor")
    createIdeSkillDir(tmpDir, ".adal")

    cleanupIdeSkillDirs(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, ".windsurf"))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, ".cursor"))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, ".adal"))).toBe(false)
  })

  it("preserves .claude and .agents directories", () => {
    createIdeSkillDir(tmpDir, ".claude")
    createIdeSkillDir(tmpDir, ".agents")
    createIdeSkillDir(tmpDir, ".windsurf")

    cleanupIdeSkillDirs(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, ".claude"))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, ".agents"))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, ".windsurf"))).toBe(false)
  })

  it("preserves other allowlisted dot-dirs (.github, .kody, .vscode, .git)", () => {
    for (const dir of [".github", ".kody", ".vscode", ".git"]) {
      const full = path.join(tmpDir, dir, "skills")
      fs.mkdirSync(full, { recursive: true })
      fs.writeFileSync(path.join(full, "file"), "content")
    }

    cleanupIdeSkillDirs(tmpDir)

    for (const dir of [".github", ".kody", ".vscode", ".git"]) {
      expect(fs.existsSync(path.join(tmpDir, dir))).toBe(true)
    }
  })

  it("does not remove dot-dirs that have more than just skills/", () => {
    const ideDir = path.join(tmpDir, ".roo")
    fs.mkdirSync(path.join(ideDir, "skills"), { recursive: true })
    fs.writeFileSync(path.join(ideDir, "config.json"), "{}")

    cleanupIdeSkillDirs(tmpDir)

    expect(fs.existsSync(ideDir)).toBe(true)
  })

  it("does not remove dot-dirs without a skills/ child", () => {
    const ideDir = path.join(tmpDir, ".some-tool")
    fs.mkdirSync(ideDir, { recursive: true })
    fs.writeFileSync(path.join(ideDir, "config.json"), "{}")

    cleanupIdeSkillDirs(tmpDir)

    expect(fs.existsSync(ideDir)).toBe(true)
  })

  it("ignores dot-prefixed files (not directories)", () => {
    fs.writeFileSync(path.join(tmpDir, ".prettierrc"), "{}")

    cleanupIdeSkillDirs(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, ".prettierrc"))).toBe(true)
  })

  it("ignores non-dot directories", () => {
    const dir = path.join(tmpDir, "node_modules", "skills")
    fs.mkdirSync(dir, { recursive: true })

    cleanupIdeSkillDirs(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, "node_modules"))).toBe(true)
  })

  it("handles empty directory gracefully", () => {
    cleanupIdeSkillDirs(tmpDir)
    // no error thrown
  })
})
