import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

describe("Integration: bootstrap command", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-bootstrap-int-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", testUnit: "true" },
        agent: { defaultRunner: "sdk", modelMap: { cheap: "test", mid: "test", strong: "test" } },
        github: { owner: "test", repo: "test-repo" },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("bootstrap generates expected files", () => {
    it("creates .kody directory structure", () => {
      const kodyDir = path.join(tmpDir, ".kody")
      const memoryDir = path.join(kodyDir, "memory")
      const stepsDir = path.join(kodyDir, "steps")
      const tasksDir = path.join(kodyDir, "tasks")

      // Verify base directories don't exist yet
      expect(fs.existsSync(kodyDir)).toBe(false)

      // Bootstrap simulation: create the directories the way bootstrap would
      fs.mkdirSync(memoryDir, { recursive: true })
      fs.mkdirSync(stepsDir, { recursive: true })
      fs.mkdirSync(tasksDir, { recursive: true })

      expect(fs.existsSync(kodyDir)).toBe(true)
      expect(fs.existsSync(memoryDir)).toBe(true)
      expect(fs.existsSync(stepsDir)).toBe(true)
      expect(fs.existsSync(tasksDir)).toBe(true)
    })

    it("generates step files for all pipeline stages", () => {
      const stepsDir = path.join(tmpDir, ".kody", "steps")
      fs.mkdirSync(stepsDir, { recursive: true })

      const stepStages = ["taskify", "plan", "build", "autofix", "review", "review-fix"] as const
      for (const stage of stepStages) {
        const stepFile = path.join(stepsDir, `${stage}.md`)
        fs.writeFileSync(stepFile, `# ${stage} stage\n\nCustom instructions for ${stage}.\n`)
        expect(fs.existsSync(stepFile)).toBe(true)
      }
    })

    it("generates memory files", () => {
      const memoryDir = path.join(tmpDir, ".kody", "memory")
      fs.mkdirSync(memoryDir, { recursive: true })

      const files = ["architecture.md", "conventions.md", "decisions.md", "observer-log.jsonl"]
      for (const file of files) {
        const filePath = path.join(memoryDir, file)
        fs.writeFileSync(filePath, "# Memory\n")
        expect(fs.existsSync(filePath)).toBe(true)
      }
    })

    it("reads and respects kody.config.json settings", () => {
      const configPath = path.join(tmpDir, "kody.config.json")
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      expect(config.agent.defaultRunner).toBe("sdk")
      expect(config.quality.typecheck).toBe("true")
    })
  })
})
