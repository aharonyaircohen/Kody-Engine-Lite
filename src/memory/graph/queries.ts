/**
 * Query layer for the flat-file graph store.
 */

import { readNodes, writeNodes, readEdges, writeEdges } from "./store.js"
// Re-export readEdges so tests can import from queries.ts
export { readEdges } from "./store.js"
import { getEpisode } from "./episode.js"
import {
  nodeIdWithTimestamp,
  edgeId,
  type GraphNode,
  type GraphEdge,
  type HallType,
  type RelationshipType,
} from "./types.js"

// ─── Node Queries ─────────────────────────────────────────────────────────────

/** Get all currently valid facts, optionally filtered by hall and/or room */
export function getCurrentFacts(
  projectDir: string,
  hall?: HallType,
  room?: string,
): GraphNode[] {
  const nodes = readNodes(projectDir)
  const now = new Date().toISOString()

  return Object.values(nodes).filter(n => {
    if (n.validTo !== null) return false
    if (hall && n.hall !== hall) return false
    if (room && n.room !== room) return false
    return true
  })
}

/** Get all facts that were valid at the given ISO timestamp */
export function getFactsAtTime(
  projectDir: string,
  isoTime: string,
  hall?: HallType,
): GraphNode[] {
  const nodes = readNodes(projectDir)

  return Object.values(nodes).filter(n => {
    if (n.validFrom > isoTime) return false
    if (n.validTo !== null && n.validTo <= isoTime) return false
    if (hall && n.hall !== hall) return false
    return true
  })
}

/** Get a single fact by ID */
export function getFactById(projectDir: string, nodeId: string): GraphNode | null {
  const nodes = readNodes(projectDir)
  return nodes[nodeId] ?? null
}

/** Get the full history of a fact by following superseded_by edges */
export function getFactHistory(projectDir: string, nodeId: string): GraphNode[] {
  const nodes = readNodes(projectDir)
  const edges = readEdges(projectDir)

  const history: GraphNode[] = []
  const visited = new Set<string>()

  function collect(id: string): void {
    if (visited.has(id)) return
    visited.add(id)

    const node = nodes[id]
    if (!node) return

    history.push(node)

    // Follow superseded_by chain
    const supersededBy = edges.find(
      e => e.from === id && e.rel === "superseded_by" && e.validTo === null,
    )
    if (supersededBy) {
      collect(supersededBy.to)
    }
  }

  collect(nodeId)

  return history.sort((a, b) => a.validFrom.localeCompare(b.validFrom))
}

/** Search facts by content (case-insensitive substring match) */
export function searchFacts(
  projectDir: string,
  query: string,
  hall?: HallType,
  limit?: number,
): GraphNode[] {
  const nodes = getCurrentFacts(projectDir, hall)
  const q = query.toLowerCase()

  const matched = nodes
    .filter(n => n.content.toLowerCase().includes(q))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom)) // newest first

  return limit ? matched.slice(0, limit) : matched
}

// ─── Edge Queries ─────────────────────────────────────────────────────────────

/** Get edges pointing away from a node */
export function getOutgoingEdges(
  projectDir: string,
  nodeId: string,
  rel?: RelationshipType,
): GraphEdge[] {
  const edges = readEdges(projectDir)
  return edges.filter(e => {
    if (e.from !== nodeId) return false
    if (e.validTo !== null) return false
    if (rel && e.rel !== rel) return false
    return true
  })
}

/** Get edges pointing toward a node */
export function getIncomingEdges(
  projectDir: string,
  nodeId: string,
  rel?: RelationshipType,
): GraphEdge[] {
  const edges = readEdges(projectDir)
  return edges.filter(e => {
    if (e.to !== nodeId) return false
    if (e.validTo !== null) return false
    if (rel && e.rel !== rel) return false
    return true
  })
}

/** Get facts related to a given node via outgoing edges */
export function getRelatedFacts(
  projectDir: string,
  nodeId: string,
  rel?: RelationshipType,
  hall?: HallType,
): GraphNode[] {
  const nodes = readNodes(projectDir)
  const outEdges = getOutgoingEdges(projectDir, nodeId, rel)

  return outEdges
    .map(e => nodes[e.to])
    .filter((n): n is GraphNode => n !== undefined && n.validTo === null)
    .filter(n => !hall || n.hall === hall)
}

// ─── Episode Queries ───────────────────────────────────────────────────────────

/** Get the episode that created a given fact */
export function getFactProvenance(projectDir: string, nodeId: string): import("./types.js").Episode | null {
  const node = getFactById(projectDir, nodeId)
  if (!node) return null
  return getEpisode(projectDir, node.episodeId)
}

// ─── Write Operations ─────────────────────────────────────────────────────────

/** Write a new fact (no invalidation of existing facts) */
export function writeFact(
  projectDir: string,
  hall: HallType,
  room: string,
  content: string,
  episodeId: string,
): GraphNode {
  const nodes = readNodes(projectDir)

  const id = nodeIdWithTimestamp(hall, room)
  const now = new Date().toISOString()

  const node: GraphNode = {
    id,
    type: hall,
    hall,
    room,
    content,
    episodeId,
    validFrom: now,
    validTo: null,
  }

  nodes[id] = node
  writeNodes(projectDir, nodes)

  return node
}

/** Update a fact: invalidates the old one, creates a new one with superseded_by edge */
export function updateFact(
  projectDir: string,
  existingNodeId: string,
  newContent: string,
  episodeId: string,
): GraphNode {
  const now = new Date().toISOString()

  // Read current state
  let nodes = readNodes(projectDir)
  const existing = nodes[existingNodeId]
  if (!existing) {
    throw new Error(`updateFact: node ${existingNodeId} not found`)
  }

  // Invalidate existing
  existing.validTo = now

  // Create new node with same hall+room
  const newId = nodeIdWithTimestamp(existing.hall, existing.room)
  const newNode: GraphNode = {
    id: newId,
    type: existing.type,
    hall: existing.hall,
    room: existing.room,
    content: newContent,
    episodeId,
    validFrom: now,
    validTo: null,
  }

  // Update nodes in memory
  nodes[existingNodeId] = existing
  nodes[newId] = newNode
  writeNodes(projectDir, nodes)

  // Write superseded_by edge
  const edges = readEdges(projectDir)
  const edge: GraphEdge = {
    id: edgeId(existingNodeId, "superseded_by", newId),
    from: existingNodeId,
    rel: "superseded_by",
    to: newId,
    episodeId,
    validFrom: now,
    validTo: null,
  }
  edges.push(edge)
  writeEdges(projectDir, edges)

  return newNode
}

/** Soft-delete a fact by setting validTo */
export function invalidateFact(projectDir: string, nodeId: string): void {
  const nodes = readNodes(projectDir)
  const node = nodes[nodeId]
  if (!node) return
  node.validTo = new Date().toISOString()
  nodes[nodeId] = node
  writeNodes(projectDir, nodes)
}

/** Write an edge between two nodes */
export function writeEdge(
  projectDir: string,
  from: string,
  rel: RelationshipType,
  to: string,
  episodeId: string,
): GraphEdge {
  const edges = readEdges(projectDir)

  const edge: GraphEdge = {
    id: edgeId(from, rel, to),
    from,
    rel,
    to,
    episodeId,
    validFrom: new Date().toISOString(),
    validTo: null,
  }

  edges.push(edge)
  writeEdges(projectDir, edges)

  return edge
}

/** Soft-delete an edge */
export function invalidateEdge(projectDir: string, edgeId: string): void {
  const edges = readEdges(projectDir)
  const edge = edges.find(e => e.id === edgeId)
  if (!edge) return
  edge.validTo = new Date().toISOString()
  writeEdges(projectDir, edges)
}
