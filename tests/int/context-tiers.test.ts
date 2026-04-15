import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import { buildFullPrompt } from "../../src/context.js"
import { inferRoomsFromScope } from "../../src/context-tiers.js"
import * as graph from "../../src/memory/graph/index.js"

describe("Integration: context and memory", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-context-int-"))
    fs.mkdirSync(path.join(tmpDir, ".kody", "tasks", "test-task"), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "true", testUnit: "true" },
        agent: { defaultRunner: "sdk", modelMap: { cheap: "test", mid: "test", strong: "test" } },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("buildFullPrompt", () => {
    it("includes task context for the plan stage", () => {
      const taskDir = path.join(tmpDir, ".kody", "tasks", "test-task")
      fs.writeFileSync(path.join(taskDir, "task.md"), "Add user authentication to the app")
      fs.writeFileSync(
        path.join(taskDir, "task.json"),
        JSON.stringify({
          task_type: "feature",
          title: "Add user auth",
          description: "Implement OAuth2 login",
          scope: ["src/auth/login.ts", "src/auth/logout.ts"],
          risk_level: "medium",
          hasUI: false,
          questions: [],
        }),
      )

      const prompt = buildFullPrompt("plan", "test-task", taskDir, tmpDir)
      expect(prompt).toContain("Add user authentication")
    })

    it("includes graph memory in plan stage prompt when facts exist", () => {
      const taskDir = path.join(tmpDir, ".kody", "tasks", "test-task")
      fs.writeFileSync(path.join(taskDir, "task.md"), "Add auth middleware")
      fs.writeFileSync(
        path.join(taskDir, "task.json"),
        JSON.stringify({
          task_type: "feature",
          title: "Auth middleware",
          description: "Add auth",
          scope: ["src/auth/middleware.ts"],
          risk_level: "low",
          hasUI: false,
          questions: [],
        }),
      )

      // Write a graph fact for the auth room
      graph.ensureGraphDir(tmpDir)
      graph.writeFact(tmpDir, "conventions", "auth", "Use JWT tokens with 1h expiry", "ep1")

      const prompt = buildFullPrompt("plan", "test-task", taskDir, tmpDir)
      expect(prompt).toContain("Relevant Project Memory")
      expect(prompt).toContain("JWT tokens")
    })

    it("does not inject memory context in non-plan stages", () => {
      const taskDir = path.join(tmpDir, ".kody", "tasks", "test-task")
      fs.writeFileSync(path.join(taskDir, "task.md"), "Write tests")

      const buildPrompt = buildFullPrompt("build", "test-task", taskDir, tmpDir)
      expect(buildPrompt).not.toContain("Relevant Project Memory")
    })
  })

  describe("inferRoomsFromScope", () => {
    it("extracts rooms from file paths", () => {
      expect(inferRoomsFromScope(["src/auth/login.ts"])).toEqual(["auth"])
      expect(inferRoomsFromScope(["src/auth/login.ts", "src/auth/logout.ts"])).toEqual(["auth"])
      expect(inferRoomsFromScope(["src/db/migrations/001.sql"])).toEqual(["db"])
      expect(inferRoomsFromScope(["src/utils/helper.ts"])).toEqual(["utils"])
    })

    it("filters out src/lib/app prefixes", () => {
      expect(inferRoomsFromScope(["src/auth/login.ts"])).toEqual(["auth"])
      expect(inferRoomsFromScope(["lib/core/util.ts"])).toEqual(["core"])
      expect(inferRoomsFromScope(["app/components/Button.tsx"])).toEqual(["components"])
    })

    it("returns empty array for empty scope", () => {
      expect(inferRoomsFromScope([])).toEqual([])
    })
  })
})
