/**
 * Flat-file graph store.
 *
 * Storage layout:
 *   .kody/graph/
 *     nodes.json      — { version, nodes: Record<nodeId, GraphNode> }
 *     nodes.json.bak  — rolling backup of the previous committed state
 *     edges.json      — { version, edges: GraphEdge[] }
 *     edges.json.bak  — rolling backup of the previous committed state
 *
 * Durability:
 *   1. Writes go to a uuid-named tmp file, are fsync'd, then renamed
 *      into place. fsync survives power-loss; rename() is atomic on POSIX.
 *   2. Before each write, the current file is copied to `<file>.bak`.
 *   3. Reads fail loud on corrupt JSON — but first try `<file>.bak` for
 *      automatic recovery. Only both-corrupt raises.
 *
 * Concurrency:
 *   atomicWrite gives crash-atomicity for a single writer, NOT serialization
 *   across concurrent writers. Callers that do read-modify-write (queries.ts,
 *   write-utils.ts, nudge.ts) MUST wrap their critical section in
 *   withGraphLockSync from ./lock.ts.
 */

import * as fs from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import type { GraphNode, GraphEdge } from "./types.js"
import { CURRENT_SCHEMA_VERSION } from "./types.js"
import { traced } from "./trace.js"

// ─── Paths ────────────────────────────────────────────────────────────────────

const GRAPH_DIR = ".kody/graph"
const NODES_FILE = "nodes.json"
const EDGES_FILE = "edges.json"

export function getGraphDir(projectDir: string): string {
  return path.join(projectDir, GRAPH_DIR)
}

export function getNodesPath(projectDir: string): string {
  return path.join(getGraphDir(projectDir), NODES_FILE)
}

export function getEdgesPath(projectDir: string): string {
  return path.join(getGraphDir(projectDir), EDGES_FILE)
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function ensureGraphDir(projectDir: string): void {
  const dir = getGraphDir(projectDir)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // Also ensure episodes subdirectory
  const episodesDir = path.join(dir, "episodes")
  if (!fs.existsSync(episodesDir)) {
    fs.mkdirSync(episodesDir, { recursive: true })
  }
}

// ─── Atomic Write ─────────────────────────────────────────────────────────────

/**
 * Atomic write:
 *   1. Back up the existing file to `<path>.bak` (if it exists)
 *   2. Write payload to a uuid-named tmp file
 *   3. fsync to flush to disk (survives power-loss)
 *   4. rename() atomically replaces the target
 *
 * Uses crypto.randomUUID() for the tmp name so crash-retries after the same
 * PID cannot collide at the same millisecond.
 */
export function atomicWrite(filePath: string, data: unknown): void {
  // 1. Back up existing file first so .bak always reflects the previous
  //    committed state. copyFileSync is atomic at the OS level and cheap.
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`)
    } catch {
      // .bak copy failure shouldn't block the write — fall through and
      // accept we lose one level of rollback. Rare.
    }
  }

  // 2. Write to UUID tmp file
  const tmp = `${filePath}.tmp.${randomUUID()}`
  const fd = fs.openSync(tmp, "w")
  try {
    const payload = JSON.stringify(data, null, 2)
    fs.writeSync(fd, payload)
    // 3. fsync survives power-loss on journaling filesystems
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  // 4. Atomic rename
  fs.renameSync(tmp, filePath)
}

// ─── Schema-versioned payloads ────────────────────────────────────────────────

type NodesPayload = { version: number; nodes: Record<string, GraphNode> }
type EdgesPayload = { version: number; edges: GraphEdge[] }

function isVersionedNodes(x: unknown): x is NodesPayload {
  return (
    typeof x === "object" &&
    x !== null &&
    "version" in x &&
    "nodes" in x &&
    typeof (x as { nodes: unknown }).nodes === "object" &&
    (x as { nodes: unknown }).nodes !== null
  )
}

function isVersionedEdges(x: unknown): x is EdgesPayload {
  return (
    typeof x === "object" &&
    x !== null &&
    "version" in x &&
    "edges" in x &&
    Array.isArray((x as { edges: unknown }).edges)
  )
}

/** Read JSON from filePath, falling back to `<filePath>.bak` on corruption. */
function readJsonWithBackup(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null
  const primary = fs.readFileSync(filePath, "utf-8")
  try {
    return JSON.parse(primary)
  } catch {
    const bakPath = `${filePath}.bak`
    if (!fs.existsSync(bakPath)) {
      throw new Error(
        `Corrupt graph file: ${filePath}. No .bak available. ` +
        `Manual recovery required — inspect the file or delete it to reset.`,
      )
    }
    const bak = fs.readFileSync(bakPath, "utf-8")
    let parsed: unknown
    try {
      parsed = JSON.parse(bak)
    } catch {
      throw new Error(
        `Corrupt graph file AND .bak: ${filePath}. ` +
        `Both primary and backup failed to parse. Manual recovery required.`,
      )
    }
    // Promote .bak back to primary so subsequent reads succeed.
    atomicWrite(filePath, parsed)
    return parsed
  }
}

// ─── Nodes ───────────────────────────────────────────────────────────────────

export function readNodes(projectDir: string): Record<string, GraphNode> {
  return traced("readNodes", () => {
    const filePath = getNodesPath(projectDir)
    const raw = readJsonWithBackup(filePath)
    if (raw === null) return {}
    if (isVersionedNodes(raw)) return raw.nodes
    // Legacy format — flat Record<id, GraphNode>. Accept and pass through;
    // the next writeNodes() will upgrade the file to versioned format.
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, GraphNode>
    }
    throw new Error(
      `Unrecognized shape in ${filePath} — expected versioned payload or ` +
      `legacy Record<id, GraphNode>.`,
    )
  }, { count: () => 0 })
}

export function writeNodes(projectDir: string, nodes: Record<string, GraphNode>): void {
  traced("writeNodes", () => {
    ensureGraphDir(projectDir)
    const payload: NodesPayload = { version: CURRENT_SCHEMA_VERSION, nodes }
    atomicWrite(getNodesPath(projectDir), payload)
  }, { count: () => Object.keys(nodes).length })
}

// ─── Edges ────────────────────────────────────────────────────────────────────

export function readEdges(projectDir: string): GraphEdge[] {
  return traced("readEdges", () => {
    const filePath = getEdgesPath(projectDir)
    const raw = readJsonWithBackup(filePath)
    if (raw === null) return []
    if (isVersionedEdges(raw)) return raw.edges
    if (Array.isArray(raw)) return raw as GraphEdge[]
    throw new Error(
      `Unrecognized shape in ${filePath} — expected versioned payload or ` +
      `legacy GraphEdge[].`,
    )
  })
}

export function writeEdges(projectDir: string, edges: GraphEdge[]): void {
  traced("writeEdges", () => {
    ensureGraphDir(projectDir)
    const payload: EdgesPayload = { version: CURRENT_SCHEMA_VERSION, edges }
    atomicWrite(getEdgesPath(projectDir), payload)
  }, { count: () => edges.length })
}
