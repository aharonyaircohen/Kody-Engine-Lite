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

  it("recognizes bootstrap as valid mode via ci-build-args", () => {
    // ci-build-args handles bootstrap: outputs "bootstrap" for MODE=bootstrap
    // The YAML delegates all mode routing to ci-build-args
    expect(template).toContain("kody-engine ci-parse")
    expect(template).toContain("kody-engine $(kody-engine ci-build-args)")
  })

  it("orchestrate handles bootstrap mode via ci-build-args", () => {
    // MODE is passed as env var, routing handled by kody-engine ci-build-args
    expect(template).toContain("MODE:")
    expect(template).toContain("kody-engine ci-build-args")
  })

  it("runs kody-engine bootstrap for bootstrap mode", () => {
    // kody-engine ci-build-args outputs "bootstrap" for MODE=bootstrap, piped to kody-engine
    expect(template).toContain("kody-engine $(kody-engine ci-build-args)")
  })

  it("uses ci-build-args for mode routing instead of shell if/elif", () => {
    // Mode routing is now in TypeScript (ci-build-args), not shell conditionals
    expect(template).not.toContain('if [ "$MODE" = "bootstrap" ]')
    expect(template).toContain("kody-engine ci-build-args")
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
