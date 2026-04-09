/**
 * Flat-file graph store.
 *
 * Storage layout:
 *   .kody/graph/
 *     nodes.json    — Record<nodeId, GraphNode>
 *     edges.json    — GraphEdge[]
 *
 * Concurrency: all writes use atomic swap (write to temp, then rename).
 * fs.rename() is atomic on POSIX systems.
 */

import * as fs from "fs"
import * as path from "path"
import type { GraphNode, GraphEdge } from "./types.js"

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
 * Atomic write: write to temp file, then rename.
 * rename() is atomic on POSIX (Linux, macOS) — safe for concurrent writes.
 */
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8")
  fs.renameSync(tmp, filePath)
}

// ─── Nodes ───────────────────────────────────────────────────────────────────

export function readNodes(projectDir: string): Record<string, GraphNode> {
  const filePath = getNodesPath(projectDir)
  if (!fs.existsSync(filePath)) return {}

  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(raw) as Record<string, GraphNode>
  } catch {
    // Corrupt JSON — return empty rather than crashing
    return {}
  }
}

export function writeNodes(projectDir: string, nodes: Record<string, GraphNode>): void {
  ensureGraphDir(projectDir)
  atomicWrite(getNodesPath(projectDir), nodes)
}

// ─── Edges ────────────────────────────────────────────────────────────────────

export function readEdges(projectDir: string): GraphEdge[] {
  const filePath = getEdgesPath(projectDir)
  if (!fs.existsSync(filePath)) return []

  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(raw) as GraphEdge[]
  } catch {
    // Corrupt JSON — return empty rather than crashing
    return []
  }
}

export function writeEdges(projectDir: string, edges: GraphEdge[]): void {
  ensureGraphDir(projectDir)
  atomicWrite(getEdgesPath(projectDir), edges)
}
