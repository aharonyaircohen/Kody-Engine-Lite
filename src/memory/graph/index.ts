/**
 * Public API for the flat-file graph memory system.
 */

// Store
export { ensureGraphDir, getGraphDir, getNodesPath, getEdgesPath, atomicWrite } from "./store.js"
export { readNodes, writeNodes, readEdges, writeEdges } from "./store.js"

// Lock
export { withGraphLock, withGraphLockSync } from "./lock.js"

// Validation
export { validateGraph } from "./validate.js"
export type { ValidationIssue, ValidationReport } from "./validate.js"

// Gitignore management for transient artifacts
export {
  ensureGraphGitignore,
  untrackGraphArtifacts,
  GRAPH_GITIGNORE_ENTRIES,
} from "./gitignore.js"

// Confidence defaults
export {
  defaultConfidenceFor,
  normalizeConfidence,
  SOURCE_CONFIDENCE,
} from "./confidence.js"

// Citation parsing for stage output
export { CITATION_INSTRUCTION, extractCitations } from "./citation.js"

// Trace
export {
  traceEnabled,
  getTraceEvents,
  getTraceSummary,
  resetTrace,
  formatTraceSummary,
} from "./trace.js"
export type { TraceEvent, TraceSummary } from "./trace.js"

// Episode
export { createEpisode, getEpisode, updateEpisode, getEpisodesBySource, getEpisodesByRun, getNextEpisodeSeq } from "./episode.js"

// Queries
export {
  getCurrentFacts,
  getFactsAtTime,
  getFactById,
  getFactHistory,
  searchFacts,
  searchFactsByScope,
  searchFactsByScopeAsOf,
  getOutgoingEdges,
  getOutgoingEdgesAtTime,
  getIncomingEdges,
  getRelatedFacts,
  getFactProvenance,
  writeFact,
  updateFact,
  invalidateFact,
  restoreFact,
  writeEdge,
  invalidateEdge,
  writeFactOrSupersede,
  findBestSimilarRecentNode,
  getRecentlyChangedFacts,
} from "./queries.js"
export type { WriteFactOutcome, RecentChange } from "./queries.js"

// Recent-changes markdown helper
export { recentChangesToMarkdown } from "./serialize.js"

// Prune archive
export { pruneInvalidatedOlderThan } from "./prune.js"
export type { PruneReport } from "./prune.js"

// Write helpers
export { factExists, inferRoom, writeFactOnce } from "./write-utils.js"

// Serialization
export { graphNodesToMarkdown } from "./serialize.js"

// Types
export type {
  GraphNode,
  GraphEdge,
  Episode,
  HallType,
  NodeType,
  RelationshipType,
  EpisodeSource,
} from "./types.js"

export {
  HallTypeValues,
  NodeTypeValues,
  RelationshipTypeValues,
  EpisodeSourceValues,
  CURRENT_SCHEMA_VERSION,
  nodeId,
  nodeIdWithTimestamp,
  edgeId,
  episodeId,
} from "./types.js"
