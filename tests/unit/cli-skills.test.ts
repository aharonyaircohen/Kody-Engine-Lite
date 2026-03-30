import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { detectSkillsForProject } from "../../src/bin/cli.js"

describe("detectSkillsForProject", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-skills-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("detects React best practices + Playwright for Next.js projects", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { next: "15.0.0", react: "19.0.0" },
      }),
    )
    const skills = detectSkillsForProject(tmpDir)
    const packages = skills.map((s) => s.package)
    expect(packages).toContain("vercel-labs/agent-skills@vercel-react-best-practices")
    expect(packages).toContain("microsoft/playwright-cli@playwright-cli")
  })

  it("detects React best practices + Playwright for React (non-Next) projects", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "19.0.0" },
        devDependencies: { vite: "6.0.0" },
      }),
    )
    const skills = detectSkillsForProject(tmpDir)
    const packages = skills.map((s) => s.package)
    expect(packages).toContain("vercel-labs/agent-skills@vercel-react-best-practices")
    expect(packages).toContain("microsoft/playwright-cli@playwright-cli")
  })

  it("detects Playwright for Vue projects", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { vue: "3.5.0" },
      }),
    )
    const skills = detectSkillsForProject(tmpDir)
    const packages = skills.map((s) => s.package)
    expect(packages).toContain("microsoft/playwright-cli@playwright-cli")
    // No React skill for Vue
    expect(packages).not.toContain("vercel-labs/agent-skills@vercel-react-best-practices")
  })

  it("detects Playwright for Svelte projects", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        devDependencies: { svelte: "5.0.0" },
      }),
    )
    const skills = detectSkillsForProject(tmpDir)
    const packages = skills.map((s) => s.package)
    expect(packages).toContain("microsoft/playwright-cli@playwright-cli")
  })

  it("returns empty for backend-only projects", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { express: "4.18.0" },
      }),
    )
    const skills = detectSkillsForProject(tmpDir)
    expect(skills).toHaveLength(0)
  })

  it("returns empty when no package.json", () => {
    const skills = detectSkillsForProject(tmpDir)
    expect(skills).toHaveLength(0)
  })

  it("returns empty for invalid package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "not json")
    const skills = detectSkillsForProject(tmpDir)
    expect(skills).toHaveLength(0)
  })

  it("does not duplicate skills when multiple rules match", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { next: "15.0.0", react: "19.0.0" },
      }),
    )
    const skills = detectSkillsForProject(tmpDir)
    const packages = skills.map((s) => s.package)
    // React best practices should appear once (Next.js rule), not twice
    const reactCount = packages.filter((p) => p.includes("vercel-react-best-practices")).length
    expect(reactCount).toBe(1)
  })

  it("each skill has package and label", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { next: "15.0.0" },
      }),
    )
    const skills = detectSkillsForProject(tmpDir)
    for (const skill of skills) {
      expect(skill.package).toBeTruthy()
      expect(skill.label).toBeTruthy()
      expect(skill.package).toContain("@") // owner/repo@skill format
    }
  })
})
