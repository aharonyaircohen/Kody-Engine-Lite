import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execSync } from "child_process"
import type { AgentRunner, AgentResult, PipelineContext } from "../../src/types.js"
import { runPipeline } from "../../src/pipeline.js"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"

function createMockRunner(): AgentRunner {
  return Object.assign(
    {
      async run(stageName: string): Promise<AgentResult> {
        if (stageName === "taskify") {
          return {
            outcome: "completed" as const,
            output: JSON.stringify({
              task_type: "feature",
              title: "Graph commit test task",
              description: "Test graph memory commit",
              scope: ["src/test.ts"],
              risk_level: "low",
            }),
          }
        }
        if (stageName === "plan") {
          return {
            outcome: "completed" as const,
            output: "## Step 1: Create test\n**File:** src/test.ts\n**Change:** Add test\n**Why:** TDD",
          }
        }
        if (stageName === "review") {
          return {
            outcome: "completed" as const,
            output: "## Verdict: PASS\n\n## Summary\nAll good.\n\n### Critical\nNone.\n### Major\nNone.\n### Minor\nNone.",
          }
        }
        if (stageName === "verify") {
          return {
            outcome: "completed" as const,
            output: JSON.stringify({
              passed: true,
              summary: "All checks passed",
              issues: { critical: [], major: [], minor: [] },
            }),
          }
        }
        return { outcome: "completed" as const, output: "Stage completed" }
      },
      async healthCheck() {
        return true
      },
    },
  )
}

function getGitLog(projectDir: string): string[] {
  try {
    return execSync("git log --oneline", { cwd: projectDir, encoding: "utf-8" })
      .split("\n")
      .filter(Boolean)
  } catch {
    return []
  }
}

function getGitStatus(projectDir: string): string {
  try {
    return execSync("git status --porcelain .kody/graph/", {
      cwd: projectDir,
      encoding: "utf-8",
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    })
  } catch {
    return ""
  }
}

describe("Integration: pipeline graph commit", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-graph-commit-"))

    // Initialize git repo
    execSync("git init", { cwd: tmpDir })
    execSync("git config user.email test@test.com", { cwd: tmpDir })
    execSync("git config user.name Test", { cwd: tmpDir })
    // Disable hooks
    execSync("git config core.hooksPath /dev/null", { cwd: tmpDir })

    // Initial commit so git log works
    fs.writeFileSync(path.join(tmpDir, "README.md"), "Test repo")
    execSync("git add README.md", { cwd: tmpDir })
    execSync("git commit -m initial", { cwd: tmpDir, env: { ...process.env, HUSKY: "0" } })

    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "", lint: "", lintFix: "", formatFix: "", testUnit: "" },
        agent: { defaultRunner: "claude", modelMap: { cheap: "claude/test", mid: "claude/test", strong: "claude/test" } },
      }),
    )
    setConfigDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("pipeline commits graph memory after successful run", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "graph-commit-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Test graph commit task")

    const ctx: PipelineContext = {
      taskId: "graph-commit-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    // Verify retrospective episode was created
    const episodesDir = path.join(tmpDir, ".kody", "graph", "episodes")
    expect(fs.existsSync(episodesDir)).toBe(true)

    const episodeFiles = fs.readdirSync(episodesDir).filter(f => f.endsWith(".json"))
    expect(episodeFiles.length).toBeGreaterThan(0)

    // Verify FTS index was updated
    const indexPath = path.join(tmpDir, ".kody", "graph", "sessions-index.json")
    expect(fs.existsSync(indexPath)).toBe(true)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"))
    expect(index.totalDocs).toBeGreaterThan(0)

    // Verify graph dir was committed to git
    const status = getGitStatus(tmpDir)
    expect(status.trim()).toBe("") // No uncommitted changes — graph was committed

    const log = getGitLog(tmpDir)
    const graphCommit = log.find(line => line.includes("graph memory"))
    expect(graphCommit).toBeDefined()
  })

  it("pipeline does not commit graph in dry-run mode", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "graph-dryrun-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Dry-run test task")

    const ctx: PipelineContext = {
      taskId: "graph-dryrun-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      input: { mode: "full", local: true, dryRun: true },
    }

    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")

    // In dry-run, no graph directory should be created
    const graphDir = path.join(tmpDir, ".kody", "graph")
    expect(fs.existsSync(graphDir)).toBe(false)
  })

  it("pipeline creates retrospective episode with correct source and content", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "retro-episode-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Retrospective episode test")

    const ctx: PipelineContext = {
      taskId: "retro-episode-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      input: { mode: "full", local: true },
    }

    await runPipeline(ctx)

    const episodesDir = path.join(tmpDir, ".kody", "graph", "episodes")
    const episodeFiles = fs.readdirSync(episodesDir).filter(f => f.endsWith(".json"))
    const retroEpisode = episodeFiles.find(f => {
      const content = JSON.parse(fs.readFileSync(path.join(episodesDir, f), "utf-8"))
      return content.source === "plan" || content.source === "ci_failure"
    })

    expect(retroEpisode).toBeDefined()
    const ep = JSON.parse(fs.readFileSync(path.join(episodesDir, retroEpisode!), "utf-8"))
    expect(ep.taskId).toBe("retro-episode-test")
    expect(ep.runId).toBe("retro-episode-test")
    expect(typeof ep.rawContent).toBe("string")
    expect(ep.rawContent.length).toBeGreaterThan(0)
    expect(ep.extractedNodeIds).toEqual([])
    expect(ep.linkedFiles).toEqual([])
  })

  it("pipeline fails gracefully when git commit fails", async () => {
    const taskDir = path.join(tmpDir, ".kody/tasks", "git-fail-test")
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, "task.md"), "Git failure test")

    // Break git config after initial commit so future commits fail
    execSync("git config user.email invalid", { cwd: tmpDir })

    const ctx: PipelineContext = {
      taskId: "git-fail-test",
      taskDir,
      projectDir: tmpDir,
      runners: { claude: createMockRunner() },
      input: { mode: "full", local: true },
    }

    // Pipeline should still complete successfully even if git commit fails
    const state = await runPipeline(ctx)
    expect(state.state).toBe("completed")

    // Episode should still exist in .kody/graph (just not committed)
    const episodesDir = path.join(tmpDir, ".kody", "graph", "episodes")
    if (fs.existsSync(episodesDir)) {
      const episodeFiles = fs.readdirSync(episodesDir).filter(f => f.endsWith(".json"))
      expect(episodeFiles.length).toBeGreaterThan(0)
    }
  })
})
