import { describe, it, expect } from "vitest"
import { buildArgs, type CiEnv } from "../../../src/ci/build-args.js"

function makeEnv(overrides: Partial<CiEnv> = {}): CiEnv {
  return {
    MODE: "",
    TASK_ID: "",
    ISSUE_NUMBER: "",
    PR_NUMBER: "",
    FROM_STAGE: "",
    COMPLEXITY: "",
    FEEDBACK: "",
    DRY_RUN: "false",
    AUTO_MODE: "false",
    FINALIZE: "false",
    BUMP: "",
    NO_PUBLISH: "false",
    NO_NOTIFY: "false",
    REVERT_TARGET: "",
    TICKET_ID: "",
    PRD_FILE: "",
    ...overrides,
  }
}

describe("buildArgs", () => {
  // ─── release ───────────────────────────────────────────────────────────────

  it("release: no flags", () => {
    expect(buildArgs(makeEnv({ MODE: "release" }))).toBe("release")
  })

  it("release: --finalize", () => {
    expect(buildArgs(makeEnv({ MODE: "release", FINALIZE: "true" }))).toBe("release --finalize")
  })

  it("release: --bump=patch", () => {
    expect(buildArgs(makeEnv({ MODE: "release", BUMP: "patch" }))).toBe("release --bump=patch")
  })

  it("release: --no-publish", () => {
    expect(buildArgs(makeEnv({ MODE: "release", NO_PUBLISH: "true" }))).toBe("release --no-publish")
  })

  it("release: --no-notify", () => {
    expect(buildArgs(makeEnv({ MODE: "release", NO_NOTIFY: "true" }))).toBe("release --no-notify")
  })

  it("release: --dry-run", () => {
    expect(buildArgs(makeEnv({ MODE: "release", DRY_RUN: "true" }))).toBe("release --dry-run")
  })

  it("release: --issue-number", () => {
    expect(buildArgs(makeEnv({ MODE: "release", ISSUE_NUMBER: "42" }))).toBe("release --issue-number 42")
  })

  it("release: all flags combined", () => {
    const env = makeEnv({
      MODE: "release",
      FINALIZE: "true",
      BUMP: "minor",
      NO_PUBLISH: "true",
      NO_NOTIFY: "true",
      DRY_RUN: "true",
      ISSUE_NUMBER: "99",
    })
    const result = buildArgs(env)
    expect(result).toContain("release")
    expect(result).toContain("--finalize")
    expect(result).toContain("--bump=minor")
    expect(result).toContain("--no-publish")
    expect(result).toContain("--no-notify")
    expect(result).toContain("--dry-run")
    expect(result).toContain("--issue-number 99")
  })

  // ─── revert ────────────────────────────────────────────────────────────────

  it("revert: no flags", () => {
    expect(buildArgs(makeEnv({ MODE: "revert" }))).toBe("revert")
  })

  it("revert: --target", () => {
    expect(buildArgs(makeEnv({ MODE: "revert", REVERT_TARGET: "87" }))).toBe("revert --target 87")
  })

  it("revert: --issue-number", () => {
    expect(buildArgs(makeEnv({ MODE: "revert", ISSUE_NUMBER: "55" }))).toBe("revert --issue-number 55")
  })

  it("revert: --dry-run", () => {
    expect(buildArgs(makeEnv({ MODE: "revert", DRY_RUN: "true" }))).toBe("revert --dry-run")
  })

  // ─── bootstrap ─────────────────────────────────────────────────────────────

  it("bootstrap: no flags", () => {
    expect(buildArgs(makeEnv({ MODE: "bootstrap" }))).toBe("bootstrap")
  })

  // ─── taskify ───────────────────────────────────────────────────────────────

  it("taskify: no flags", () => {
    expect(buildArgs(makeEnv({ MODE: "taskify" }))).toBe("taskify")
  })

  it("taskify: --ticket", () => {
    expect(buildArgs(makeEnv({ MODE: "taskify", TICKET_ID: "PROJ-123" }))).toBe("taskify --ticket PROJ-123")
  })

  it("taskify: --file", () => {
    expect(buildArgs(makeEnv({ MODE: "taskify", PRD_FILE: "prd.md" }))).toBe("taskify --file prd.md")
  })

  it("taskify: --issue-number", () => {
    expect(buildArgs(makeEnv({ MODE: "taskify", ISSUE_NUMBER: "7" }))).toBe("taskify --issue-number 7")
  })

  // ─── run (default) ─────────────────────────────────────────────────────────

  it("run: --issue-number only", () => {
    expect(buildArgs(makeEnv({ ISSUE_NUMBER: "42" }))).toBe("run --issue-number 42")
  })

  it("run: --task-id", () => {
    expect(buildArgs(makeEnv({ TASK_ID: "abc-123" }))).toBe("run --task-id abc-123")
  })

  it("run: --pr-number", () => {
    expect(buildArgs(makeEnv({ PR_NUMBER: "15" }))).toBe("run --pr-number 15")
  })

  it("run: --from", () => {
    expect(buildArgs(makeEnv({ FROM_STAGE: "build" }))).toBe("run --from build")
  })

  it("run: --complexity", () => {
    expect(buildArgs(makeEnv({ COMPLEXITY: "high" }))).toBe("run --complexity high")
  })

  it("run: --dry-run", () => {
    expect(buildArgs(makeEnv({ DRY_RUN: "true" }))).toBe("run --dry-run")
  })

  it("run: --auto-mode", () => {
    expect(buildArgs(makeEnv({ AUTO_MODE: "true" }))).toBe("run --auto-mode")
  })

  // ─── mode remapping ────────────────────────────────────────────────────────

  it("MODE=rerun maps to subcommand rerun", () => {
    expect(buildArgs(makeEnv({ MODE: "rerun", ISSUE_NUMBER: "5" }))).toBe("rerun --issue-number 5")
  })

  it("MODE=fix maps to subcommand fix", () => {
    expect(buildArgs(makeEnv({ MODE: "fix", ISSUE_NUMBER: "6" }))).toBe("fix --issue-number 6")
  })

  it("MODE=fix-ci maps to subcommand fix-ci", () => {
    expect(buildArgs(makeEnv({ MODE: "fix-ci", ISSUE_NUMBER: "7" }))).toBe("fix-ci --issue-number 7")
  })

  it("MODE=review maps to subcommand review", () => {
    expect(buildArgs(makeEnv({ MODE: "review", ISSUE_NUMBER: "8" }))).toBe("review --issue-number 8")
  })

  it("MODE=resolve maps to subcommand resolve", () => {
    expect(buildArgs(makeEnv({ MODE: "resolve", ISSUE_NUMBER: "9" }))).toBe("resolve --issue-number 9")
  })

  it("MODE=hotfix maps to subcommand hotfix", () => {
    expect(buildArgs(makeEnv({ MODE: "hotfix", ISSUE_NUMBER: "10" }))).toBe("hotfix --issue-number 10")
  })

  it("MODE=status maps to subcommand status", () => {
    expect(buildArgs(makeEnv({ MODE: "status" }))).toBe("status")
  })
})
