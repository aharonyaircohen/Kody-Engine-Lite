import { describe, it, expect } from "vitest"
import { isForbiddenPath, normalizeCommitMessage } from "../../../src-v2/commit.js"

describe("commit: isForbiddenPath", () => {
  it("blocks .kody/ artifacts", () => {
    expect(isForbiddenPath(".kody/tasks/1/x.json")).toBe(true)
    expect(isForbiddenPath(".kody-engine/event-log.json")).toBe(true)
    expect(isForbiddenPath(".kody2/last-run.jsonl")).toBe(true)
    expect(isForbiddenPath(".kody-lean/last-run.jsonl")).toBe(true)
  })

  it("blocks node_modules and build outputs", () => {
    expect(isForbiddenPath("node_modules/foo/index.js")).toBe(true)
    expect(isForbiddenPath("dist/cli.js")).toBe(true)
    expect(isForbiddenPath("build/x")).toBe(true)
  })

  it("blocks .env exact and .log suffix", () => {
    expect(isForbiddenPath(".env")).toBe(true)
    expect(isForbiddenPath("debug.log")).toBe(true)
    expect(isForbiddenPath("logs/x.log")).toBe(true)
  })

  it("allows source files", () => {
    expect(isForbiddenPath("src/foo.ts")).toBe(false)
    expect(isForbiddenPath("README.md")).toBe(false)
    expect(isForbiddenPath("package.json")).toBe(false)
  })

  it("does not block .env.example", () => {
    expect(isForbiddenPath(".env.example")).toBe(false)
  })
})

describe("commit: normalizeCommitMessage", () => {
  it("preserves messages with valid conventional prefix", () => {
    expect(normalizeCommitMessage("feat: add X")).toBe("feat: add X")
    expect(normalizeCommitMessage("fix: handle Y")).toBe("fix: handle Y")
    expect(normalizeCommitMessage("chore: bump deps")).toBe("chore: bump deps")
  })

  it("prepends chore: when prefix missing", () => {
    expect(normalizeCommitMessage("update readme")).toBe("chore: update readme")
  })

  it("strips surrounding quotes", () => {
    expect(normalizeCommitMessage('"feat: x"')).toBe("feat: x")
    expect(normalizeCommitMessage("'fix: y'")).toBe("fix: y")
  })

  it("handles empty input", () => {
    expect(normalizeCommitMessage("")).toBe("chore: kody2 update")
    expect(normalizeCommitMessage("   ")).toBe("chore: kody2 update")
  })

  it("recognizes prefix case-insensitively", () => {
    expect(normalizeCommitMessage("Feat: add X")).toBe("Feat: add X")
  })

  it("checks only first line for prefix", () => {
    const msg = "feat: add X\n\nLong body\nfix: not a prefix here"
    expect(normalizeCommitMessage(msg)).toBe(msg)
  })
})
