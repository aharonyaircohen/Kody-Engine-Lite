/**
 * Query layer for the flat-file graph store.
 */

import { readNodes, writeNodes, readEdges, writeEdges } from "./store.js"
// Re-export readEdges so tests can import from queries.ts
export { readEdges } from "./store.js"
import { getEpisode } from "./episode.js"
import { withGraphLockSync } from "./lock.js"
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

/**
 * Infer memory "rooms" from a file scope array.
 * e.g. ["src/auth/login.ts", "src/auth/logout.ts"] → ["auth"]
 * Inlined here to avoid circular import with context-tiers.ts.
 */
function inferRoomsFromScope(scope: string[]): string[] {
  if (scope.length === 0) return []
  const rooms = new Set<string>()
  for (const filePath of scope) {
    const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean)
    const meaningful = parts.filter(
      (p) => p !== "src" && p !== "lib" && p !== "app" && !p.includes("."),
    )
    if (meaningful.length > 0) {
      rooms.add(meaningful[0].toLowerCase())
    }
  }
  return [...rooms]
}

/**
 * Search graph memory for facts relevant to the current task scope.
 * Used by the plan stage to inject relevant project memory into the prompt.
 */
export function searchFactsByScope(
  projectDir: string,
  scope: string[],
  limit = 5,
): GraphNode[] {
  if (scope.length === 0) return []
  const rooms = inferRoomsFromScope(scope)
  const allFacts = getCurrentFacts(projectDir)
  const firstFile = scope[0]?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? ""
  const q = rooms.join(" ").toLowerCase()

  return allFacts
    .filter(
      (n) =>
        (n.room && q.includes(n.room)) ||
        (firstFile && n.content.toLowerCase().includes(firstFile.toLowerCase())),
    )
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    .slice(0, limit)
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
  tags?: string[],
): GraphNode {
  return withGraphLockSync(projectDir, () => {
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
      ...(tags && tags.length > 0 ? { tags } : {}),
    }

    nodes[id] = node
    writeNodes(projectDir, nodes)

    return node
  })
}

// Common English stopwords + throwaway tokens that would inflate Jaccard overlap.
const DEDUP_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "may", "might", "must", "can", "to", "of", "in", "on", "at",
  "by", "for", "with", "about", "as", "into", "through", "during",
  "before", "after", "above", "below", "from", "up", "down", "out",
  "off", "over", "under", "again", "then", "once", "and", "or", "but",
  "not", "no", "so", "if", "because", "when", "where", "why", "how",
  "all", "any", "both", "each", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "than", "too", "very", "this", "that",
  "these", "those", "it", "its", "itself", "they", "them", "their",
  "which", "who", "whom", "whose", "what",
])

/**
 * Tokenize text for Jaccard comparison. Lowercase, keep only alphanumerics,
 * drop stopwords and tokens shorter than 3 chars. Returns a set.
 */
/** Naïve plural/gerund stemmer — covers "users"/"user", "breaks"/"break", "hooks"/"hook". */
function stem(tok: string): string {
  if (tok.length > 4 && tok.endsWith("ies")) return tok.slice(0, -3) + "y"
  if (tok.length > 4 && tok.endsWith("es")) return tok.slice(0, -2)
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1)
  return tok
}

function tokenizeForDedup(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (raw.length < 3) continue
    if (DEDUP_STOPWORDS.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}

/**
 * Sørensen-Dice coefficient over two token sets. More forgiving of size
 * differences than Jaccard — a terse paraphrase of a verbose insight still
 * scores high. Returns 1.0 if both sets are empty; 0 if only one is empty.
 */
function sorensenDice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  return (2 * intersection) / (a.size + b.size)
}

/** Exact-equality fallback for too-short content where Sørensen-Dice is meaningless. */
function normalizeForExactMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
}

// If either side has fewer than this many significant tokens, skip fuzzy
// comparison and fall back to exact match — otherwise short strings that
// collapse to a single shared token (e.g. "lesson 1" vs "lesson 2" → {lesson})
// would dedup against each other.
const MIN_TOKENS_FOR_FUZZY = 3

/**
 * Find a recent node in the same hall whose content is near-identical to
 * `content`. Uses Sørensen-Dice over significant tokens for substantial
 * content; falls back to exact-match for short content. Used as a novelty
 * gate for LLM-produced insights where the same idea gets paraphrased
 * differently each run.
 *
 * Room is NOT required to match — LLMs pick different room labels (e.g.
 * `auth` vs `auth/access-control`) for the same lesson, so filtering by room
 * would let those through.
 */
export function findSimilarRecentNode(
  projectDir: string,
  hall: HallType,
  content: string,
  maxAgeDays = 30,
  similarityThreshold = 0.6,
): GraphNode | null {
  const nodes = readNodes(projectDir)
  const targetTokens = tokenizeForDedup(content)
  const targetExact = normalizeForExactMatch(content)
  if (!targetExact) return null

  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString()

  for (const node of Object.values(nodes)) {
    if (node.hall !== hall) continue
    if (node.validFrom < cutoff) continue

    const nodeTokens = tokenizeForDedup(node.content)
    const useFuzzy =
      targetTokens.size >= MIN_TOKENS_FOR_FUZZY &&
      nodeTokens.size >= MIN_TOKENS_FOR_FUZZY

    if (useFuzzy) {
      if (sorensenDice(targetTokens, nodeTokens) >= similarityThreshold) return node
    } else if (normalizeForExactMatch(node.content) === targetExact) {
      return node
    }
  }
  return null
}

/**
 * Read the most recent nodes whose tags include `tag`.
 * Used to retrieve stage-scoped insights for prompt injection.
 */
export function readNodesByTag(
  projectDir: string,
  tag: string,
  limit = 5,
): GraphNode[] {
  const nodes = readNodes(projectDir)
  return Object.values(nodes)
    .filter((n) => n.validTo === null && Array.isArray(n.tags) && n.tags.includes(tag))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    .slice(0, limit)
}

/** Update a fact: invalidates the old one, creates a new one with superseded_by edge */
export function updateFact(
  projectDir: string,
  existingNodeId: string,
  newContent: string,
  episodeId: string,
): GraphNode {
  return withGraphLockSync(projectDir, () => {
    const now = new Date().toISOString()

    // Read current state
    const nodes = readNodes(projectDir)
    const existing = nodes[existingNodeId]
    if (!existing) {
      throw new Error(`updateFact: node ${existingNodeId} not found`)
    }

    // Invalidate existing (immutable update — don't mutate the live object)
    const invalidated: GraphNode = { ...existing, validTo: now }

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
    nodes[existingNodeId] = invalidated
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
  })
}

/** Soft-delete a fact by setting validTo */
export function invalidateFact(projectDir: string, nodeId: string): void {
  withGraphLockSync(projectDir, () => {
    const nodes = readNodes(projectDir)
    const node = nodes[nodeId]
    if (!node) return
    nodes[nodeId] = { ...node, validTo: new Date().toISOString() }
    writeNodes(projectDir, nodes)
  })
}

/** Write an edge between two nodes */
export function writeEdge(
  projectDir: string,
  from: string,
  rel: RelationshipType,
  to: string,
  episodeId: string,
): GraphEdge {
  return withGraphLockSync(projectDir, () => {
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
  })
}

/** Soft-delete an edge */
export function invalidateEdge(projectDir: string, edgeId: string): void {
  withGraphLockSync(projectDir, () => {
    const edges = readEdges(projectDir)
    const idx = edges.findIndex(e => e.id === edgeId)
    if (idx === -1) return
    edges[idx] = { ...edges[idx], validTo: new Date().toISOString() }
    writeEdges(projectDir, edges)
  })
}
