/**
 * A2 tests — cross-process write lock.
 *
 * Spawns N child processes each calling writeFact once against the same
 * graph directory. Without the lock, the read-modify-write pattern loses
 * updates. With the lock, every write must be observable in the final
 * nodes.json.
 *
 * Also tests writeFactOnce TOCTOU: if two processes simultaneously try to
 * write the same (hall, room, content), exactly one should succeed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..", "..")

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-concurrent-"))
}

// Spawns a tsx subprocess that runs the given code against `projectDir`.
function runInChild(scriptBody: string, projectDir: string, index: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const script = `
      process.chdir(${JSON.stringify(projectDir)})
      ;(async () => {
        ${scriptBody}
      })().then(
        () => process.exit(0),
        (err) => { console.error(err?.stack || err); process.exit(1) }
      )
    `
    const tmpScript = path.join(projectDir, `.child-${index}.mjs`)
    fs.writeFileSync(tmpScript, script)
    try {
      const stdout = execFileSync("npx", ["tsx", tmpScript], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      })
      resolve({ stdout, stderr: "", code: 0 })
    } catch (err: any) {
      resolve({
        stdout: err.stdout?.toString?.() ?? "",
        stderr: err.stderr?.toString?.() ?? String(err),
        code: err.status ?? 1,
      })
    }
  })
}

describe("concurrent writes (A2)", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = tmpProject()
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it("10 concurrent writeFact calls all persist (no lost updates)", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    const N = 10
    const childScript = (i: number) => `
      const { writeFact } = await import(${JSON.stringify(path.join(REPO_ROOT, "src/memory/graph/queries.ts"))})
      writeFact(${JSON.stringify(projectDir)}, "facts", "concurrency", "child-" + ${i}, "ep_1")
    `

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => runInChild(childScript(i), projectDir, i)),
    )

    const failed = results.filter(r => r.code !== 0)
    expect(failed, failed.map(f => f.stderr).join("\n---\n")).toHaveLength(0)

    const { readNodes } = await import("../../src/memory/graph/store.js")
    const nodes = readNodes(projectDir)
    const contents = Object.values(nodes).map(n => n.content).sort()
    const expected = Array.from({ length: N }, (_, i) => `child-${i}`).sort()
    expect(contents).toEqual(expected)
  }, 60_000)

  it("concurrent writeFactOnce with identical content writes exactly one node (TOCTOU-safe)", async () => {
    const { ensureGraphDir } = await import("../../src/memory/graph/store.js")
    ensureGraphDir(projectDir)

    const N = 8
    const childScript = () => `
      const { writeFactOnce } = await import(${JSON.stringify(path.join(REPO_ROOT, "src/memory/graph/write-utils.ts"))})
      writeFactOnce(${JSON.stringify(projectDir)}, "conventions", "testing", "Use Vitest", "ep_1")
    `

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => runInChild(childScript(), projectDir, i)),
    )
    const failed = results.filter(r => r.code !== 0)
    expect(failed, failed.map(f => f.stderr).join("\n---\n")).toHaveLength(0)

    const { readNodes } = await import("../../src/memory/graph/store.js")
    const nodes = readNodes(projectDir)
    const matching = Object.values(nodes).filter(
      n => n.hall === "conventions" && n.room === "testing" && n.content === "Use Vitest" && n.validTo === null,
    )
    expect(matching).toHaveLength(1)
  }, 60_000)
})
