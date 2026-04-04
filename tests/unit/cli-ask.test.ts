import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { parseArgs } from "../../src/cli/args.js"

describe("parseArgs --ask shorthand", () => {
  let originalArgv: string[]

  beforeEach(() => {
    originalArgv = process.argv
  })

  afterEach(() => {
    process.argv = originalArgv
  })

  it("--ask sets command to ask and feedback to the question", () => {
    process.argv = ["node", "kody", "--ask", "What framework is this?"]
    const input = parseArgs()
    expect(input.command).toBe("ask")
    expect(input.feedback).toBe("What framework is this?")
  })

  it("--ask with --cwd sets working directory", () => {
    process.argv = ["node", "kody", "--ask", "How does auth work?", "--cwd", "/tmp/project"]
    const input = parseArgs()
    expect(input.command).toBe("ask")
    expect(input.feedback).toBe("How does auth work?")
    expect(input.cwd).toBe("/tmp/project")
  })

  it("--ask with --issue-number includes issue context", () => {
    process.argv = ["node", "kody", "--ask", "Explain this issue", "--issue-number", "42"]
    const input = parseArgs()
    expect(input.command).toBe("ask")
    expect(input.feedback).toBe("Explain this issue")
    expect(input.issueNumber).toBe(42)
  })

  it("--ask without issue number works (pure local)", () => {
    process.argv = ["node", "kody", "--ask", "What is this project?"]
    const input = parseArgs()
    expect(input.command).toBe("ask")
    expect(input.issueNumber).toBeUndefined()
  })

  it("--ask defaults to local mode outside CI", () => {
    delete process.env.GITHUB_ACTIONS
    process.argv = ["node", "kody", "--ask", "Question"]
    const input = parseArgs()
    expect(input.local).toBe(true)
  })
})
