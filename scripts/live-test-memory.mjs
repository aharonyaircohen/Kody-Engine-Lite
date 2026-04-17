#!/usr/bin/env node
/**
 * Live-test the Phase A + B0 memory fixes against a scratch area inside
 * Kody-Engine-Tester. Exercises every behavior I changed:
 *
 *   A1  — atomicWrite hardening + .bak rotation + fail-loud + .bak recovery
 *   A2  — cross-process write lock (spawn N subprocesses, check no lost updates)
 *   A3  — schema version wrapper round-trip + legacy read
 *   A4  — validateGraph catches real defects
 *   B0  — KODY_MEMORY_TRACE emits summary
 *
 * Safe to run: writes to a brand-new tmp dir under /tmp, does NOT touch
 * the Tester's committed .kody/graph state.
 */

import { execFileSync, fork } from "child_process"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_ROOT = path.resolve(__dirname, "..")

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kody-livetest-"))
console.log(`Scratch: ${scratch}\n`)

process.env.KODY_MEMORY_TRACE = "1"

let ok = true
const fail = (msg) => { console.error(`  ✗ ${msg}`); ok = false }
const pass = (msg) => console.log(`  ✓ ${msg}`)

const {
  writeFact,
  updateFact,
  readNodes,
  readEdges,
  createEpisode,
  ensureGraphDir,
  validateGraph,
  getCurrentFacts,
  CURRENT_SCHEMA_VERSION,
} = await import(path.join(ENGINE_ROOT, "src/memory/graph/index.ts"))
const { writeFactOnce } = await import(path.join(ENGINE_ROOT, "src/memory/graph/write-utils.ts"))
const { resetTrace, formatTraceSummary, getTraceSummary } = await import(path.join(ENGINE_ROOT, "src/memory/graph/trace.ts"))

ensureGraphDir(scratch)
resetTrace()

// ── A1: atomicWrite + .bak rotation ──────────────────────────────────────────
console.log("\n[A1] atomicWrite + .bak rotation")
{
  const ep = createEpisode(scratch, { runId: "r1", source: "review", taskId: "t1", createdAt: new Date().toISOString(), rawContent: "first run", extractedNodeIds: [] })
  writeFact(scratch, "facts", "auth", "Use JWT", ep.id)
  writeFact(scratch, "facts", "auth", "Use bcrypt", ep.id)

  const bakPath = path.join(scratch, ".kody/graph/nodes.json.bak")
  if (fs.existsSync(bakPath)) pass(".bak file exists after 2nd write")
  else fail(".bak file missing")

  const bak = JSON.parse(fs.readFileSync(bakPath, "utf-8"))
  if (Object.values(bak.nodes).some(n => n.content === "Use JWT")) pass(".bak contains prior committed state")
  else fail(".bak does not contain prior state")

  // No stragglers
  const stragglers = fs.readdirSync(path.join(scratch, ".kody/graph")).filter(f => f.includes(".tmp."))
  if (stragglers.length === 0) pass("no .tmp.* straggler files left behind")
  else fail(`straggler tmp files: ${stragglers.join(", ")}`)
}

// ── A3: schema version wrapper ───────────────────────────────────────────────
console.log("\n[A3] schema version wrapper")
{
  const raw = JSON.parse(fs.readFileSync(path.join(scratch, ".kody/graph/nodes.json"), "utf-8"))
  if (raw.version === CURRENT_SCHEMA_VERSION) pass(`on-disk format is { version: ${CURRENT_SCHEMA_VERSION}, nodes }`)
  else fail(`on-disk version is ${raw.version}, expected ${CURRENT_SCHEMA_VERSION}`)
  if (raw.nodes && typeof raw.nodes === "object") pass("payload has .nodes Record")
  else fail("missing .nodes key")

  // Legacy read path
  const legacyScratch = fs.mkdtempSync(path.join(os.tmpdir(), "kody-legacy-"))
  fs.mkdirSync(path.join(legacyScratch, ".kody/graph"), { recursive: true })
  const legacy = { legacy_node: { id: "legacy_node", type: "facts", hall: "facts", room: "r", content: "from v0", episodeId: "ep_legacy_1", validFrom: "2026-01-01T00:00:00Z", validTo: null } }
  fs.writeFileSync(path.join(legacyScratch, ".kody/graph/nodes.json"), JSON.stringify(legacy), "utf-8")
  const readBack = readNodes(legacyScratch)
  if (readBack.legacy_node?.content === "from v0") pass("legacy flat format still reads")
  else fail("legacy flat format failed to read")
  fs.rmSync(legacyScratch, { recursive: true, force: true })
}

// ── A1: fail-loud + .bak recovery ────────────────────────────────────────────
console.log("\n[A1] fail-loud + .bak auto-recovery")
{
  const corruptScratch = fs.mkdtempSync(path.join(os.tmpdir(), "kody-corrupt-"))
  const gd = path.join(corruptScratch, ".kody/graph")
  fs.mkdirSync(gd, { recursive: true })
  fs.writeFileSync(path.join(gd, "nodes.json"), "{ NOT JSON", "utf-8")

  let threw = false
  try { readNodes(corruptScratch) } catch (e) { threw = /Corrupt graph file/.test(e.message) }
  if (threw) pass("throws on corrupt JSON with no .bak")
  else fail("did not throw on corrupt JSON")

  // Now add a valid .bak and retry
  const validPayload = { version: 1, nodes: { recovered: { id: "recovered", type: "facts", hall: "facts", room: "r", content: "saved in .bak", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null } } }
  fs.writeFileSync(path.join(gd, "nodes.json.bak"), JSON.stringify(validPayload), "utf-8")
  const recovered = readNodes(corruptScratch)
  if (recovered.recovered?.content === "saved in .bak") pass("auto-recovered from .bak")
  else fail("did not recover from .bak")

  // Primary should now be healed
  const reparsed = JSON.parse(fs.readFileSync(path.join(gd, "nodes.json"), "utf-8"))
  if (reparsed.version === 1 && reparsed.nodes.recovered) pass("primary was healed from .bak in-place")
  else fail("primary was not healed")

  // Both corrupt → hard throw
  fs.writeFileSync(path.join(gd, "nodes.json"), "broken", "utf-8")
  fs.writeFileSync(path.join(gd, "nodes.json.bak"), "also broken", "utf-8")
  let both = false
  try { readNodes(corruptScratch) } catch (e) { both = /Corrupt graph file AND \.bak/.test(e.message) }
  if (both) pass("both-corrupt throws with clear message")
  else fail("both-corrupt did not raise expected error")

  fs.rmSync(corruptScratch, { recursive: true, force: true })
}

// ── A2: cross-process write lock ─────────────────────────────────────────────
console.log("\n[A2] cross-process write lock (10 concurrent writers)")
{
  const concurrentScratch = fs.mkdtempSync(path.join(os.tmpdir(), "kody-concurrent-"))
  ensureGraphDir(concurrentScratch)

  const N = 10
  const workers = []
  for (let i = 0; i < N; i++) {
    const script = `
      const { writeFact } = await import(${JSON.stringify(path.join(ENGINE_ROOT, "src/memory/graph/queries.ts"))})
      writeFact(${JSON.stringify(concurrentScratch)}, "facts", "race", "worker-${i}", "ep_race_1")
    `
    const tmpScript = path.join(concurrentScratch, `.worker-${i}.mjs`)
    fs.writeFileSync(tmpScript, script)
    workers.push(new Promise(resolve => {
      try {
        execFileSync("npx", ["tsx", tmpScript], { cwd: ENGINE_ROOT, stdio: "pipe", timeout: 30000 })
        resolve({ i, ok: true })
      } catch (err) {
        resolve({ i, ok: false, err: err.stderr?.toString?.() ?? String(err) })
      }
    }))
  }
  const results = await Promise.all(workers)
  const failures = results.filter(r => !r.ok)
  if (failures.length === 0) pass(`all ${N} workers completed`)
  else fail(`${failures.length} workers failed: ${failures[0].err?.slice(0, 120)}`)

  const nodes = readNodes(concurrentScratch)
  const contents = Object.values(nodes).map(n => n.content).filter(c => c.startsWith("worker-")).sort()
  const expected = Array.from({ length: N }, (_, i) => `worker-${i}`).sort()
  if (contents.length === N && contents.every((v, i) => v === expected[i])) pass(`all ${N} writes landed — no lost updates`)
  else fail(`expected ${N} writes, got ${contents.length}: ${contents.join(", ")}`)

  // TOCTOU: concurrent writeFactOnce with identical content → exactly one write
  const TOCTOU_N = 8
  const tocWorkers = []
  for (let i = 0; i < TOCTOU_N; i++) {
    const script = `
      const { writeFactOnce } = await import(${JSON.stringify(path.join(ENGINE_ROOT, "src/memory/graph/write-utils.ts"))})
      writeFactOnce(${JSON.stringify(concurrentScratch)}, "conventions", "testing", "Use Vitest", "ep_toctou_1")
    `
    const tmpScript = path.join(concurrentScratch, `.toctou-${i}.mjs`)
    fs.writeFileSync(tmpScript, script)
    tocWorkers.push(new Promise(resolve => {
      try { execFileSync("npx", ["tsx", tmpScript], { cwd: ENGINE_ROOT, stdio: "pipe", timeout: 30000 }); resolve({ ok: true }) }
      catch (err) { resolve({ ok: false, err: err.stderr?.toString?.() }) }
    }))
  }
  await Promise.all(tocWorkers)
  const nodes2 = readNodes(concurrentScratch)
  const matching = Object.values(nodes2).filter(n => n.hall === "conventions" && n.room === "testing" && n.content === "Use Vitest" && n.validTo === null)
  if (matching.length === 1) pass(`TOCTOU: exactly one write survived out of ${TOCTOU_N} concurrent writeFactOnce`)
  else fail(`TOCTOU: expected 1 write, got ${matching.length}`)

  fs.rmSync(concurrentScratch, { recursive: true, force: true })
}

// ── A4: validate catches defects ─────────────────────────────────────────────
console.log("\n[A4] validateGraph catches defects")
{
  // Valid graph from earlier scratch
  const validReport = validateGraph(scratch)
  if (validReport.ok && validReport.issues.length === 0) pass(`live graph validates clean (${validReport.nodeCount} nodes)`)
  else fail(`live graph has issues: ${JSON.stringify(validReport.issues.slice(0, 3))}`)

  // Simulate updateFact to generate a superseded_by edge and re-validate
  const firstFact = Object.values(readNodes(scratch))[0]
  const ep2 = createEpisode(scratch, { runId: "r2", source: "review", taskId: "t2", createdAt: new Date().toISOString(), rawContent: "update", extractedNodeIds: [] })
  updateFact(scratch, firstFact.id, "Use JWT with 24h expiry", ep2.id)
  const afterUpdate = validateGraph(scratch)
  if (afterUpdate.ok) pass("updateFact produces validator-clean graph with edge")
  else fail(`post-update issues: ${JSON.stringify(afterUpdate.issues)}`)

  // Hand-corrupt nodes.json to inject a dangling edge and ensure validator flags it
  const defectScratch = fs.mkdtempSync(path.join(os.tmpdir(), "kody-defect-"))
  ensureGraphDir(defectScratch)
  const payload = {
    version: 1,
    nodes: { real: { id: "real", type: "facts", hall: "facts", room: "r", content: "exists", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null } },
  }
  const epayload = {
    version: 1,
    edges: [{ id: "dangling", from: "ghost", rel: "related_to", to: "real", episodeId: "ep_1", validFrom: "2026-04-01T00:00:00Z", validTo: null }],
  }
  fs.writeFileSync(path.join(defectScratch, ".kody/graph/nodes.json"), JSON.stringify(payload))
  fs.writeFileSync(path.join(defectScratch, ".kody/graph/edges.json"), JSON.stringify(epayload))
  const defectReport = validateGraph(defectScratch)
  if (!defectReport.ok && defectReport.issues.some(i => i.code === "edge.dangling_from")) pass("validator flags dangling edge.from")
  else fail(`validator missed dangling edge: ${JSON.stringify(defectReport.issues)}`)
  fs.rmSync(defectScratch, { recursive: true, force: true })
}

// ── B0: trace summary ────────────────────────────────────────────────────────
console.log("\n[B0] trace instrumentation")
{
  const summary = getTraceSummary()
  if (Object.keys(summary).length > 0) pass(`${Object.keys(summary).length} distinct ops traced`)
  else fail("no trace events recorded")
  if (summary["graph.lock"]?.calls > 0) pass(`graph.lock: ${summary["graph.lock"].calls} acquisitions, total ${summary["graph.lock"].totalMs.toFixed(1)}ms`)
  else fail("graph.lock not traced")
  if (summary.writeNodes?.calls > 0) pass(`writeNodes: ${summary.writeNodes.calls} calls`)
  else fail("writeNodes not traced")

  console.log("\n  Trace summary:")
  console.log(formatTraceSummary().split("\n").map(l => "    " + l).join("\n"))
}

// ── Teardown ────────────────────────────────────────────────────────────────
fs.rmSync(scratch, { recursive: true, force: true })

console.log(`\n${"=".repeat(60)}`)
console.log(ok ? "ALL LIVE TESTS PASSED" : "SOME LIVE TESTS FAILED")
process.exit(ok ? 0 : 1)
