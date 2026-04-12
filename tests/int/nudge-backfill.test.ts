import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { resetProjectConfig, setConfigDir } from "../../src/config.js"
import { ensureGraphDir } from "../../src/memory/graph/index.js"
import { createEpisode, getEpisode, getEpisodesBySource } from "../../src/memory/graph/episode.js"
import { writeFact, getCurrentFacts } from "../../src/memory/graph/queries.js"
import { indexEpisode, searchSessions } from "../../src/memory/search.js"
import type { Episode } from "../../src/memory/graph/types.js"

describe("Integration: nudge backfill extractedNodeIds", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-nudge-backfill-"))
    fs.writeFileSync(
      path.join(tmpDir, "kody.config.json"),
      JSON.stringify({
        agent: { defaultRunner: "sdk", modelMap: { cheap: "test", mid: "test", strong: "test" } },
      }),
    )
    setConfigDir(tmpDir)
    ensureGraphDir(tmpDir)
  })

  afterEach(() => {
    resetProjectConfig()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("createEpisode initializes extractedNodeIds as empty array", () => {
    const episode = createEpisode(tmpDir, {
      runId: "task_backfill_test",
      source: "nudge",
      taskId: "task_backfill_test",
      createdAt: new Date().toISOString(),
      rawContent: "LLM nudge identified patterns",
      extractedNodeIds: [],
      linkedFiles: [],
    })

    expect(episode.extractedNodeIds).toEqual([])
    expect(episode.id).toMatch(/^ep_nudge_\d+$/)
  })

  it("backfill updates extractedNodeIds on existing episode file", () => {
    const episode = createEpisode(tmpDir, {
      runId: "task_backfill",
      source: "nudge",
      taskId: "task_backfill",
      createdAt: new Date().toISOString(),
      rawContent: "Patterns found from this run",
      extractedNodeIds: [],
      linkedFiles: [],
    })

    // Simulate what nudge.ts does: write fact nodes then backfill extractedNodeIds
    const node1 = writeFact(tmpDir, "conventions", "auth", "Use JWT for stateless auth", episode.id)
    const node2 = writeFact(tmpDir, "preferences", "style", "User prefers functional patterns", episode.id)

    // Backfill: read episode, update extractedNodeIds, write back
    const episodePath = path.join(tmpDir, ".kody", "graph", "episodes", `${episode.id}.json`)
    const episodeData = JSON.parse(fs.readFileSync(episodePath, "utf-8")) as Episode
    episodeData.extractedNodeIds = [node1.id, node2.id]
    fs.writeFileSync(episodePath, JSON.stringify(episodeData, null, 2) + "\n")

    // Verify getEpisode returns updated extractedNodeIds
    const updated = getEpisode(tmpDir, episode.id)!
    expect(updated.extractedNodeIds).toEqual([node1.id, node2.id])
  })

  it("nudge episode is searchable via FTS after creation", () => {
    const episode = createEpisode(tmpDir, {
      runId: "task_fts_nudge",
      source: "nudge",
      taskId: "task_fts_nudge",
      createdAt: new Date().toISOString(),
      rawContent: "Convention: use Zod for runtime validation of API inputs",
      extractedNodeIds: [],
      linkedFiles: [],
    })

    const results = searchSessions(tmpDir, "Zod runtime validation API")
    const nudgeEp = results.find(r => r.episodeId === episode.id)
    expect(nudgeEp).toBeDefined()
    expect(nudgeEp!.source).toBe("nudge")
    expect(nudgeEp!.taskId).toBe("task_fts_nudge")
  })

  it("getEpisodesBySource returns all nudge episodes", () => {
    createEpisode(tmpDir, {
      runId: "task_nudge_1",
      source: "nudge",
      taskId: "task_nudge_1",
      createdAt: new Date().toISOString(),
      rawContent: "Episode 1",
      extractedNodeIds: [],
      linkedFiles: [],
    })
    createEpisode(tmpDir, {
      runId: "task_nudge_2",
      source: "nudge",
      taskId: "task_nudge_2",
      createdAt: new Date().toISOString(),
      rawContent: "Episode 2",
      extractedNodeIds: [],
      linkedFiles: [],
    })
    // Also create a plan episode to ensure filtering works
    createEpisode(tmpDir, {
      runId: "task_plan_1",
      source: "plan",
      taskId: "task_plan_1",
      createdAt: new Date().toISOString(),
      rawContent: "Plan episode",
      extractedNodeIds: [],
      linkedFiles: [],
    })

    const nudgeEpisodes = getEpisodesBySource(tmpDir, "nudge")
    expect(nudgeEpisodes.length).toBe(2)
    expect(nudgeEpisodes.every(e => e.source === "nudge")).toBe(true)
  })

  it("facts written by nudge link back to episode via episodeId", () => {
    const episode = createEpisode(tmpDir, {
      runId: "task_fact_links",
      source: "nudge",
      taskId: "task_fact_links",
      createdAt: new Date().toISOString(),
      rawContent: "Conventions from this task",
      extractedNodeIds: [],
      linkedFiles: [],
    })

    const fact = writeFact(tmpDir, "conventions", "testing", "Use TDD for new features", episode.id)

    // Verify the fact's episodeId matches the episode
    expect(fact.episodeId).toBe(episode.id)

    // Facts can be retrieved and filtered by room
    const facts = getCurrentFacts(tmpDir, "conventions", "testing")
    expect(facts.length).toBe(1)
    expect(facts[0]!.id).toBe(fact.id)
    expect(facts[0]!.episodeId).toBe(episode.id)
  })

  it("backfill handles zero patterns gracefully", () => {
    // When nudge finds no patterns, extractedNodeIds stays empty
    const episode = createEpisode(tmpDir, {
      runId: "task_no_patterns",
      source: "nudge",
      taskId: "task_no_patterns",
      createdAt: new Date().toISOString(),
      rawContent: "No useful patterns found",
      extractedNodeIds: [],
      linkedFiles: [],
    })

    // Backfill with empty array (nudge found no patterns)
    const episodePath = path.join(tmpDir, ".kody", "graph", "episodes", `${episode.id}.json`)
    const episodeData = JSON.parse(fs.readFileSync(episodePath, "utf-8")) as Episode
    episodeData.extractedNodeIds = []
    fs.writeFileSync(episodePath, JSON.stringify(episodeData, null, 2) + "\n")

    const updated = getEpisode(tmpDir, episode.id)!
    expect(updated.extractedNodeIds).toEqual([])
  })

  it("episode sequence numbers increment per source", () => {
    const ep1 = createEpisode(tmpDir, {
      runId: "task_seq_1",
      source: "nudge",
      taskId: "task_seq_1",
      createdAt: new Date().toISOString(),
      rawContent: "First nudge",
      extractedNodeIds: [],
      linkedFiles: [],
    })
    const ep2 = createEpisode(tmpDir, {
      runId: "task_seq_2",
      source: "nudge",
      taskId: "task_seq_2",
      createdAt: new Date().toISOString(),
      rawContent: "Second nudge",
      extractedNodeIds: [],
      linkedFiles: [],
    })

    // Both are nudge episodes but should have different sequence numbers
    expect(ep1.id).not.toBe(ep2.id)

    // Plan episodes get their own sequence
    const planEp = createEpisode(tmpDir, {
      runId: "task_seq_3",
      source: "plan",
      taskId: "task_seq_3",
      createdAt: new Date().toISOString(),
      rawContent: "Plan episode",
      extractedNodeIds: [],
      linkedFiles: [],
    })
    expect(planEp.id).toMatch(/^ep_plan_/)
  })

  it("episode rawContent is stored and retrievable from FTS index", () => {
    const uniqueContent = `Event: CI failed due to missing environment variable in deployment script`

    const episode = createEpisode(tmpDir, {
      runId: "task_raw_content",
      source: "ci_failure",
      taskId: "task_raw_content",
      createdAt: new Date().toISOString(),
      rawContent: uniqueContent,
      extractedNodeIds: [],
      linkedFiles: [],
    })

    const results = searchSessions(tmpDir, "environment variable CI deployment")
    const matched = results.find(r => r.episodeId === episode.id)
    expect(matched).toBeDefined()
    expect(matched!.snippet).toContain("environment")
    expect(matched!.snippet).toContain("CI")
  })
})
