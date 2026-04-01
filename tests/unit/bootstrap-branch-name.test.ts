import { describe, it, expect } from "vitest"

/**
 * Bootstrap creates branches named kody-bootstrap-{timestamp}.
 * Using a hyphen (not slash) avoids git ref conflicts when a 'kody' branch exists,
 * since git can't have both 'kody' (file) and 'kody/foo' (directory) in refs/heads/.
 */
describe("bootstrap branch naming", () => {
  it("uses hyphen separator to avoid git ref namespace conflicts", async () => {
    // Read the source and verify the branch name pattern
    const fs = await import("fs")
    const path = await import("path")
    const { fileURLToPath } = await import("url")

    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const cliSource = fs.readFileSync(
      path.resolve(__dirname, "../../src/bin/commands/bootstrap.ts"),
      "utf-8",
    )

    // Must use kody-bootstrap (hyphen), NOT kody/bootstrap (slash)
    expect(cliSource).toContain("kody-bootstrap-")
    expect(cliSource).not.toMatch(/[`"']kody\/bootstrap/)
  })
})
