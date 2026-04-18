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
  getFactsAtTime,
  getFactProvenance,
  getGraphDir,
  graphNodesToMarkdown,
  validateGraph,
  formatTraceSummary,
  traceEnabled,
  invalidateFact,
  restoreFact,
  createEpisode,
  pruneInvalidatedOlderThan,
} from "../../memory/graph/index.js"
import { migrateProjectMemory } from "../../memory/migration.js"
import { searchSessions } from "../../memory/search.js"

/** Extract --as-of=<iso> flag. Returns null if absent; throws on invalid date. */
function parseAsOf(args: string[]): string | null {
  const flagIdx = args.findIndex((a) => a === "--as-of" || a.startsWith("--as-of="))
  if (flagIdx === -1) return null
  const raw = args[flagIdx].includes("=")
    ? args[flagIdx].split("=", 2)[1]
    : args[flagIdx + 1]
  if (!raw) {
    console.error("--as-of requires a timestamp (ISO 8601 or YYYY-MM-DD)")
    process.exit(1)
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    console.error(`Invalid --as-of timestamp: ${raw}`)
    process.exit(1)
  }
  return parsed.toISOString()
}

/** Remove --as-of and its value from args so positional parsing stays intact. */
function stripAsOf(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--as-of") {
      i++ // skip value
      continue
    }
    if (a.startsWith("--as-of=")) continue
    out.push(a)
  }
  return out
}

export async function runGraphCommand(args: string[]): Promise<void> {
  const asOf = parseAsOf(args)
  args = stripAsOf(args)
  const sub = args[0]

  if (sub === "status") {
    const projectDir = args[1] || process.cwd()
    printStatus(projectDir, asOf)
  } else if (sub === "migrate") {
    const projectDir = args[1] || process.cwd()
    await runMigrate(projectDir)
  } else if (sub === "query") {
    const projectDir = args[1] || process.cwd()
    const query = args[2]
    await runQuery(projectDir, query, asOf)
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
  } else if (sub === "validate") {
    const projectDir = args[1] || process.cwd()
    runValidate(projectDir)
  } else if (sub === "trace") {
    runTrace()
  } else if (sub === "forget") {
    const projectDir = args[1] || process.cwd()
    const nodeId = args[2]
    const reasonIdx = args.findIndex((a) => a === "--reason")
    const reason = reasonIdx >= 0 ? (args[reasonIdx + 1] ?? "") : ""
    runForget(projectDir, nodeId, reason)
  } else if (sub === "restore") {
    const projectDir = args[1] || process.cwd()
    const nodeId = args[2]
    runRestore(projectDir, nodeId)
  } else if (sub === "prune") {
    const projectDir = args[1] || process.cwd()
    const olderIdx = args.findIndex((a) => a === "--invalidated-older-than")
    const rawDays = olderIdx >= 0 ? args[olderIdx + 1] : undefined
    const days = rawDays ? parseInt(rawDays, 10) : 90
    if (Number.isNaN(days) || days < 0) {
      console.error(`Invalid --invalidated-older-than value: ${rawDays}`)
      process.exit(1)
    }
    const dryRun = args.includes("--dry-run")
    runPrune(projectDir, days, dryRun)
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
  kody graph status <projectDir> [--as-of=<iso>]       Show graph stats
  kody graph migrate <projectDir>                       Migrate legacy .md files to graph
  kody graph query <projectDir> [q] [--as-of=<iso>]    List/search facts (optionally at a past time)
  kody graph show <projectDir> <id>                     Show fact + provenance + history
  kody graph search <projectDir> <q>                    Full-text search across sessions
  kody graph validate <projectDir>                      Check graph invariants (dangling refs, cycles, bad timestamps)
  kody graph trace                                      Print KODY_MEMORY_TRACE summary
  kody graph forget <projectDir> <id> [--reason "…"]   Soft-delete a fact (retraction episode created)
  kody graph restore <projectDir> <id>                  Un-delete a previously forgotten fact
  kody graph prune <projectDir> [--invalidated-older-than=<days>] [--dry-run]
                                                        Archive invalidated facts older than N days (default 90)
  kody graph clear <projectDir> --confirm               Reset graph

Examples:
  kody graph status .
  kody graph status . --as-of=2026-03-01
  kody graph query . JWT
  kody graph query . --as-of=2026-03-01
  kody graph show . facts_auth_123456
  kody graph clear . --confirm
`)
}

function printStatus(projectDir: string, asOf: string | null = null): void {
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

  console.log(`\nGraph Memory Status${asOf ? ` (as of ${asOf})` : ""}`)
  console.log(`  Graph dir:   ${graphDir}`)
  console.log(`  Nodes:      ${nodeCount}`)
  console.log(`  Edges:      ${edgeCount}`)
  console.log(`  Episodes:   ${episodeCount}`)

  const nodes = asOf ? getFactsAtTime(projectDir, asOf) : getCurrentFacts(projectDir)
  const byHall: Record<string, number> = {}
  for (const n of nodes) {
    byHall[n.hall] = (byHall[n.hall] || 0) + 1
  }
  console.log(`\n  ${asOf ? "Facts by hall at timestamp" : "Current facts by hall"}:`)
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

async function runQuery(
  projectDir: string,
  query: string | undefined,
  asOf: string | null = null,
): Promise<void> {
  if (!query) {
    const nodes = asOf ? getFactsAtTime(projectDir, asOf) : getCurrentFacts(projectDir)
    if (nodes.length === 0) {
      console.log(
        asOf
          ? `\nNo facts were live at ${asOf}.`
          : "\nNo facts in graph. Run `kody graph migrate` first.",
      )
      return
    }
    console.log(`\n${nodes.length} ${asOf ? `facts live at ${asOf}` : "current facts"}:`)
    const md = graphNodesToMarkdown(nodes)
    console.log(md)
    return
  }

  // Substring search; when asOf is set, restrict to facts live at that time.
  const candidates = asOf ? getFactsAtTime(projectDir, asOf) : getCurrentFacts(projectDir)
  const q = query.toLowerCase()
  const results = candidates
    .filter((n) => n.content.toLowerCase().includes(q))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))

  if (results.length === 0) {
    console.log(
      asOf
        ? `\nNo facts matching "${query}" were live at ${asOf}`
        : `\nNo facts matching "${query}"`,
    )
    return
  }

  console.log(
    `\n${results.length} facts matching "${query}"${asOf ? ` (as of ${asOf})` : ""}:`,
  )
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

function runValidate(projectDir: string): void {
  const report = validateGraph(projectDir)
  console.log(`\nGraph validation for ${projectDir}`)
  console.log(`  Nodes:     ${report.nodeCount}`)
  console.log(`  Edges:     ${report.edgeCount}`)
  console.log(`  Episodes:  ${report.episodeCount}`)
  console.log(`  Status:    ${report.ok ? "ok" : "ERRORS"}`)

  if (report.issues.length === 0) {
    console.log("  No issues.")
    return
  }

  const errors = report.issues.filter(i => i.severity === "error")
  const warnings = report.issues.filter(i => i.severity === "warning")

  if (errors.length > 0) {
    console.log(`\n  ${errors.length} error(s):`)
    for (const i of errors) {
      console.log(`    [${i.code}] ${i.subject}: ${i.message}`)
    }
  }
  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} warning(s):`)
    for (const i of warnings) {
      console.log(`    [${i.code}] ${i.subject}: ${i.message}`)
    }
  }

  if (!report.ok) process.exit(1)
}

function runForget(projectDir: string, nodeId: string | undefined, reason: string): void {
  if (!nodeId) {
    console.error("Usage: kody graph forget <projectDir> <node-id> [--reason \"…\"]")
    process.exit(1)
  }
  const before = getFactById(projectDir, nodeId)
  if (!before) {
    console.error(`\nFact not found: ${nodeId}`)
    process.exit(1)
  }
  if (before.validTo !== null) {
    console.log(`\n○ Fact ${nodeId} was already forgotten at ${before.validTo}`)
    return
  }

  // Create a retraction episode first so the invalidation is traceable.
  const episode = createEpisode(projectDir, {
    runId: `forget-${Date.now()}`,
    source: "retraction",
    taskId: nodeId,
    createdAt: new Date().toISOString(),
    rawContent: `User retracted fact ${nodeId}${reason ? ` — reason: ${reason}` : ""}`,
    extractedNodeIds: [nodeId],
    linkedFiles: [],
    metadata: { reason: reason || "(no reason given)" },
  })

  const after = invalidateFact(projectDir, nodeId)
  if (!after) {
    console.error(`\n✗ invalidateFact returned null for ${nodeId}`)
    process.exit(1)
  }

  console.log(`\n✓ Forgot ${nodeId}`)
  console.log(`  Content:   ${after.content.slice(0, 80)}${after.content.length > 80 ? "..." : ""}`)
  console.log(`  validTo:   ${after.validTo}`)
  console.log(`  Episode:   ${episode.id}`)
  if (reason) console.log(`  Reason:    ${reason}`)
  console.log(`\n  To undo:   kody graph restore ${projectDir} ${nodeId}`)
}

function runRestore(projectDir: string, nodeId: string | undefined): void {
  if (!nodeId) {
    console.error("Usage: kody graph restore <projectDir> <node-id>")
    process.exit(1)
  }
  const before = getFactById(projectDir, nodeId)
  if (!before) {
    console.error(`\nFact not found: ${nodeId}`)
    process.exit(1)
  }
  if (before.validTo === null) {
    console.log(`\n○ Fact ${nodeId} is already active (validTo was null)`)
    return
  }

  const after = restoreFact(projectDir, nodeId)
  if (!after) {
    console.error(`\n✗ restoreFact returned null`)
    process.exit(1)
  }

  console.log(`\n✓ Restored ${nodeId}`)
  console.log(`  Content:  ${after.content.slice(0, 80)}${after.content.length > 80 ? "..." : ""}`)
  console.log(`  validTo:  ${after.validTo ?? "null (active)"}`)
}

function runPrune(projectDir: string, days: number, dryRun: boolean): void {
  const report = pruneInvalidatedOlderThan(projectDir, days, { dryRun })
  console.log(`\n${dryRun ? "[dry-run] " : ""}Prune — invalidated facts older than ${days}d`)
  console.log(`  Cutoff:              ${report.cutoff}`)
  console.log(`  Nodes archived:      ${report.nodesArchived}`)
  console.log(`  Edges archived:      ${report.edgesArchived}`)
  console.log(`  Nodes remaining:     ${report.nodesRemaining}`)
  console.log(`  Edges remaining:     ${report.edgesRemaining}`)
  if (!dryRun && (report.nodesArchived > 0 || report.edgesArchived > 0)) {
    console.log(`  Archive file:        ${report.archivedFile}`)
  } else if (dryRun) {
    console.log(`  (would write to:    ${report.archivedFile})`)
  }
}

function runTrace(): void {
  if (!traceEnabled()) {
    console.log(
      "KODY_MEMORY_TRACE is not enabled. Set KODY_MEMORY_TRACE=1 in the " +
      "environment of the process you want to profile — this command only " +
      "prints the summary collected during the current process's lifetime.",
    )
    return
  }
  console.log(formatTraceSummary())
}
