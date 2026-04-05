import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..", "..")

describe("workflow template", () => {
  const templatePath = path.join(PKG_ROOT, "templates", "kody.yml")

  it("template file exists", () => {
    expect(fs.existsSync(templatePath)).toBe(true)
  })

  const template = fs.readFileSync(templatePath, "utf-8")

  it("recognizes bootstrap as valid mode", () => {
    expect(template).toContain("bootstrap")
    // The parse step invokes the TS parser via ci-parse
    expect(template).toContain("kody-engine ci-parse")
  })

  it("orchestrate handles bootstrap mode", () => {
    expect(template).toContain('MODE" = "bootstrap"')
    expect(template).toContain("kody-engine bootstrap")
  })

  it("runs kody-engine bootstrap for bootstrap mode", () => {
    expect(template).toContain("kody-engine bootstrap")
  })

  it("has separate bootstrap path from normal pipeline", () => {
    // Bootstrap should be in an if/else with normal pipeline
    expect(template).toContain('if [ "$MODE" = "bootstrap" ]')
  })

  it("includes all required workflow triggers", () => {
    expect(template).toContain("workflow_dispatch:")
    expect(template).toContain("issue_comment:")
    expect(template).toContain("pull_request_review:")
    expect(template).toContain("push:")
  })

  it("includes parse, orchestrate, and error notification jobs", () => {
    expect(template).toContain("parse:")
    expect(template).toContain("orchestrate:")
    expect(template).toContain("notify-parse-error:")
    expect(template).toContain("notify-orchestrate-error:")
  })

  it("installs kody-engine and claude-code in orchestrate", () => {
    expect(template).toContain("npm install -g @kody-ade/engine")
    expect(template).toContain("npm install -g @anthropic-ai/claude-code")
  })

  it("configures git user in orchestrate", () => {
    expect(template).toContain("git config user.email")
    expect(template).toContain("git config user.name")
  })

  it("has artifact upload step", () => {
    expect(template).toContain("actions/upload-artifact@v4")
    expect(template).toContain("path: .kody/tasks/")
  })
})
