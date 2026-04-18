import { describe, it, expect } from "vitest"
import { spawnSync } from "child_process"
import * as path from "path"

const ROOT = path.resolve(__dirname, "..")

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", "bin-v2/kody-lean.ts", ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

describe("e2e: CLI smoke", () => {
  it("prints help with no args", () => {
    const r = runCli([])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/kody-lean/)
    expect(r.stdout).toMatch(/Usage/)
  })

  it("prints help with --help", () => {
    const r = runCli(["--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/kody-lean/)
  })

  it("prints version", () => {
    const r = runCli(["--version"])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/0\./)
  })

  it("rejects run without --issue", () => {
    const r = runCli(["run"])
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/--issue/)
  })

  it("rejects unknown command", () => {
    const r = runCli(["frobnicate"])
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/unknown command/)
  })

  it("rejects unknown flag", () => {
    const r = runCli(["run", "--issue", "1", "--bogus"])
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/--bogus/)
  })

  it("rejects non-positive issue number", () => {
    const r = runCli(["run", "--issue", "0"])
    expect(r.code).toBe(64)
    expect(r.stderr).toMatch(/positive integer/)
  })
})
