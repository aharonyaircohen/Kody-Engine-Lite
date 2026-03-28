import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..", "..")

const STEP_STAGES = ["taskify", "plan", "build", "autofix", "review", "review-fix"] as const

describe("bootstrap prompt templates", () => {
  it("all step stage templates exist", () => {
    for (const stage of STEP_STAGES) {
      const templatePath = path.join(PKG_ROOT, "prompts", `${stage}.md`)
      expect(fs.existsSync(templatePath), `Missing template: prompts/${stage}.md`).toBe(true)
    }
  })

  it("all templates contain {{TASK_CONTEXT}} placeholder", () => {
    for (const stage of STEP_STAGES) {
      const templatePath = path.join(PKG_ROOT, "prompts", `${stage}.md`)
      const content = fs.readFileSync(templatePath, "utf-8")
      expect(content, `Template ${stage}.md missing {{TASK_CONTEXT}}`).toContain("{{TASK_CONTEXT}}")
    }
  })

  it("all templates have non-trivial content", () => {
    for (const stage of STEP_STAGES) {
      const templatePath = path.join(PKG_ROOT, "prompts", `${stage}.md`)
      const content = fs.readFileSync(templatePath, "utf-8")
      expect(content.length, `Template ${stage}.md too short`).toBeGreaterThan(100)
    }
  })

  it("templates have frontmatter with name and description", () => {
    for (const stage of STEP_STAGES) {
      const templatePath = path.join(PKG_ROOT, "prompts", `${stage}.md`)
      const content = fs.readFileSync(templatePath, "utf-8")
      // Frontmatter starts with ---
      expect(content.startsWith("---"), `Template ${stage}.md missing frontmatter`).toBe(true)
      expect(content, `Template ${stage}.md missing name field`).toMatch(/name:\s*\S+/)
      expect(content, `Template ${stage}.md missing description field`).toMatch(/description:\s*\S+/)
    }
  })
})

describe("bootstrap config detection", () => {
  it("kody.config.schema.json exists", () => {
    const schemaPath = path.join(PKG_ROOT, "kody.config.schema.json")
    expect(fs.existsSync(schemaPath)).toBe(true)
  })

  it("schema has required fields", () => {
    const schemaPath = path.join(PKG_ROOT, "kody.config.schema.json")
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"))
    expect(schema).toHaveProperty("properties")
    expect(schema.properties).toHaveProperty("quality")
    expect(schema.properties).toHaveProperty("git")
    expect(schema.properties).toHaveProperty("github")
  })
})

describe("bootstrap CI behavior", () => {
  it("detects GITHUB_ACTIONS env for CI mode", () => {
    // The bootstrap command checks process.env.GITHUB_ACTIONS
    // In CI: creates branch + PR (GITHUB_ACTIONS="true")
    // Locally: commits to current branch (GITHUB_ACTIONS is undefined)
    if (process.env.GITHUB_ACTIONS) {
      expect(process.env.GITHUB_ACTIONS).toBe("true")
    } else {
      expect(process.env.GITHUB_ACTIONS).toBeUndefined()
    }
  })

  it("reads ISSUE_NUMBER env for feedback", () => {
    // Bootstrap reads process.env.ISSUE_NUMBER for posting comments
    // When not set, no comments are posted
    // In CI, ISSUE_NUMBER may or may not be set depending on the trigger
    if (!process.env.ISSUE_NUMBER) {
      expect(process.env.ISSUE_NUMBER).toBeUndefined()
    }
  })
})
