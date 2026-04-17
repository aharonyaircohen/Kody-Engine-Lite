// Storage schema version. Bump when the on-disk shape of nodes.json /
// edges.json changes. Readers accept legacy (unversioned) payloads and
// rewrite them in the current format on first write.
export const CURRENT_SCHEMA_VERSION = 1 as const

// Hall types — categories for memory entries
export const HallTypeValues = [
  "facts",
  "conventions",
  "events",
  "preferences",
  "thoughts",
] as const

export type HallType = (typeof HallTypeValues)[number]

// Node types include halls plus derived/source for internal use
export const NodeTypeValues = [
  ...HallTypeValues,
  "derived",
  "source",
] as const

export type NodeType = (typeof NodeTypeValues)[number]

// Relationship types — edges between nodes
export const RelationshipTypeValues = [
  "superseded_by",
  "supersedes",
  "applies_to",
  "related_to",
  "caused_by",
  "derived_from",
] as const

export type RelationshipType = (typeof RelationshipTypeValues)[number]

// Episode source types — where facts originate
export const EpisodeSourceValues = [
  "plan",
  "review",
  "user_feedback",
  "ci_failure",
  "decompose",
  "migration",
  "nudge",
  "stage_diary",
  "retraction",
] as const

export type EpisodeSource = (typeof EpisodeSourceValues)[number]

// ─── Core Interfaces ──────────────────────────────────────────────────────────

export interface GraphNode {
  id: string
  type: NodeType
  hall: HallType
  room: string
  content: string
  episodeId: string
  validFrom: string
  validTo: string | null
  tags?: string[]
  /** Soft confidence signal in [0,1]; omitted for legacy nodes. */
  confidence?: number
}

export interface GraphEdge {
  id: string
  from: string
  rel: RelationshipType
  to: string
  episodeId: string
  validFrom: string
  validTo: string | null
}

export interface Episode {
  id: string
  runId: string
  source: EpisodeSource
  taskId: string
  createdAt: string
  rawContent: string
  extractedNodeIds: string[]
  linkedFiles?: string[]
  metadata?: Record<string, unknown>
}

// ─── ID Helpers ────────────────────────────────────────────────────────────────

/** Generate a stable node ID from hall + room + optional version marker */
export function nodeId(hall: HallType, room: string, version?: string): string {
  const slug = room.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
  const base = `${hall}_${slug}`
  return version ? `${base}_${version}` : base
}

/** Generate a node ID with timestamp suffix for uniqueness.
 * Uses hrtime.bigint() for nanosecond precision — avoids collisions on fast synchronous writes.
 */
export function nodeIdWithTimestamp(hall: HallType, room: string): string {
  const ts = process.hrtime.bigint().toString()
  return `${nodeId(hall, room)}_${ts}`
}

/** Generate an edge ID */
export function edgeId(from: string, rel: RelationshipType, to: string): string {
  return `${from}_${rel}_${to}`
}

/** Generate an episode ID from source + sequence number */
export function episodeId(source: EpisodeSource, seq: number): string {
  return `ep_${source}_${String(seq).padStart(3, "0")}`
}
