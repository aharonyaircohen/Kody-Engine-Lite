/**
 * `kody graph` — Graph memory management CLI.
 *
 * Usage:
 *   kody graph status <projectDir>   — show graph stats (nodes, edges, episodes)
 *   kody graph migrate <projectDir>   — migrate legacy .md memory to graph
 *   kody graph query <projectDir> [query]  — search facts
 *   kody graph show <projectDir> <nodeId>  — show fact + history
 *   kody graph clear <projectDir> --confirm  — reset graph
 *   kody graph search <projectDir> <query>  — search sessions (FTS)
 */

import * as fs from "fs"
import * as path from "path"
import {
  getCurrentFacts,
  getFactById,
  getFactHistory,
  searchFacts,
  getFactProvenance,
  getGraphDir,
  graphNodesToMarkdown,
} from "../../memory/graph/index.js"
import { migrateProjectMemory } from "../../memory/migration.js"
import { searchSessions } from "../../memory/search.js"

export async function runGraphCommand(args: string[]): Promise<void> {
  const sub = args[0]

  if (sub === "status") {
    const projectDir = args[1] || process.cwd()
    printStatus(projectDir)
  } else if (sub === "migrate") {
    const projectDir = args[1] || process.cwd()
    await runMigrate(projectDir)
  } else if (sub === "query") {
    const projectDir = args[1] || process.cwd()
    const query = args[2]
    await runQuery(projectDir, query)
  } else if (sub === "show") {
    const projectDir = args[1] || process.cwd()
    const nodeId = args[2]
    await runShow(projectDir, nodeId)
  } else if (sub === "clear") {
    const projectDir = args[1] || process.cwd()
    if (!args.includes("--confirm")) {
      console.log("\nThis will delete all graph data. Add --confirm to proceed:")
      console.log("  kody graph clear <projectDir> --confirm")
      return
    }
    runClear(projectDir)
  } else if (sub === "search") {
    const projectDir = args[1] || process.cwd()
    const query = args.slice(2).join(" ")
    runSearch(projectDir, query)
  } else if (!sub) {
    printHelp()
  } else {
    console.error(`Unknown subcommand: ${sub}`)
    printHelp()
    process.exit(1)
  }
}

function printHelp(): void {
  console.log(`
kody graph — Graph memory management

Usage:
  kody graph status <projectDir>   Show graph stats
  kody graph migrate <projectDir>   Migrate legacy .md files to graph
  kody graph query <projectDir> <q> Search facts
  kody graph show <projectDir> <id> Show fact + provenance + history
  kody graph search <projectDir> <q> Full-text search across sessions
  kody graph clear <projectDir> --confirm  Reset graph

Examples:
  kody graph status .
  kody graph migrate .
  kody graph query . JWT
  kody graph show . facts_auth_123456
  kody graph search . authentication
  kody graph clear . --confirm
`)
}

function printStatus(projectDir: string): void {
  const graphDir = getGraphDir(projectDir)
  const nodesPath = path.join(graphDir, "nodes.json")
  const edgesPath = path.join(graphDir, "edges.json")
  const episodesDir = path.join(graphDir, "episodes")

  let nodeCount = 0
  let edgeCount = 0
  let episodeCount = 0

  if (fs.existsSync(nodesPath)) {
    try {
      const nodes = JSON.parse(fs.readFileSync(nodesPath, "utf-8"))
      nodeCount = Object.keys(nodes).length
    } catch { /* ignore */ }
  }

  if (fs.existsSync(edgesPath)) {
    try {
      const edges = JSON.parse(fs.readFileSync(edgesPath, "utf-8"))
      edgeCount = edges.length
    } catch { /* ignore */ }
  }

  if (fs.existsSync(episodesDir)) {
    episodeCount = fs.readdirSync(episodesDir).filter(f => f.endsWith(".json")).length
  }

  console.log(`\nGraph Memory Status`)
  console.log(`  Graph dir:   ${graphDir}`)
  console.log(`  Nodes:      ${nodeCount}`)
  console.log(`  Edges:      ${edgeCount}`)
  console.log(`  Episodes:   ${episodeCount}`)

  const nodes = getCurrentFacts(projectDir)
  const byHall: Record<string, number> = {}
  for (const n of nodes) {
    byHall[n.hall] = (byHall[n.hall] || 0) + 1
  }
  console.log(`\n  Current facts by hall:`)
  for (const [hall, count] of Object.entries(byHall).sort()) {
    console.log(`    ${hall}: ${count}`)
  }
}

async function runMigrate(projectDir: string): Promise<void> {
  console.log(`\nMigrating legacy .md memory to graph...`)
  const result = await migrateProjectMemory(projectDir)
  console.log(`  Migrated:  ${result.migrated} facts`)
  console.log(`  Skipped:   ${result.skipped} files`)
  if (result.errors.length > 0) {
    console.log(`  Errors:`)
    for (const err of result.errors) {
      console.log(`    - ${err}`)
    }
  } else {
    console.log(`  ✓ No errors`)
  }
  printStatus(projectDir)
}

async function runQuery(projectDir: string, query?: string): Promise<void> {
  if (!query) {
    // Show all current facts
    const nodes = getCurrentFacts(projectDir)
    if (nodes.length === 0) {
      console.log("\nNo facts in graph. Run `kody graph migrate` first.")
      return
    }
    console.log(`\n${nodes.length} current facts:`)
    const md = graphNodesToMarkdown(nodes)
    console.log(md)
    return
  }

  const results = searchFacts(projectDir, query)
  if (results.length === 0) {
    console.log(`\nNo facts matching "${query}"`)
    return
  }

  console.log(`\n${results.length} facts matching "${query}":`)
  const md = graphNodesToMarkdown(results)
  console.log(md)
}

function runSearch(projectDir: string, query: string): void {
  if (!query) {
    console.error("Usage: kody graph search <projectDir> <query>")
    process.exit(1)
  }

  const results = searchSessions(projectDir, query)
  if (results.length === 0) {
    console.log(`\nNo sessions matching "${query}"`)
    return
  }

  console.log(`\n${results.length} sessions matching "${query}":`)
  for (const r of results) {
    console.log(`\n[${r.source}] ${r.taskId} (score: ${r.score})`)
    console.log(`  Created: ${r.createdAt.slice(0, 10)}`)
    console.log(`  ${r.snippet}`)
  }
}

async function runShow(projectDir: string, nodeId?: string): Promise<void> {
  if (!nodeId) {
    console.error("Usage: kody graph show <projectDir> <nodeId>")
    process.exit(1)
  }

  const node = getFactById(projectDir, nodeId)
  if (!node) {
    console.log(`\nFact "${nodeId}" not found`)
    return
  }

  console.log(`\n## Fact: ${node.id}`)
  console.log(`  Hall:      ${node.hall}`)
  console.log(`  Room:      ${node.room}`)
  console.log(`  Content:   ${node.content}`)
  console.log(`  Episode:   ${node.episodeId}`)
  console.log(`  Valid:     ${node.validFrom} → ${node.validTo ?? "now"}`)

  const provenance = getFactProvenance(projectDir, nodeId)
  if (provenance) {
    console.log(`\n## Provenance (Episode)`)
    console.log(`  Source:    ${provenance.source}`)
    console.log(`  Run:       ${provenance.runId}`)
    console.log(`  Task:      ${provenance.taskId}`)
    console.log(`  Created:   ${provenance.createdAt}`)
    console.log(`  Raw:       ${provenance.rawContent}`)
  }

  const history = getFactHistory(projectDir, nodeId)
  if (history.length > 1) {
    console.log(`\n## History (${history.length} versions)`)
    for (const v of history) {
      console.log(`  - ${v.validFrom}: ${v.content} ${v.validTo ? `(→ ${v.validTo})` : "(current)"}`)
    }
  }
}

function runClear(projectDir: string): void {
  const graphDir = getGraphDir(projectDir)
  if (fs.existsSync(graphDir)) {
    fs.rmSync(graphDir, { recursive: true, force: true })
  }
  console.log("\n✓ Graph cleared.")
}
