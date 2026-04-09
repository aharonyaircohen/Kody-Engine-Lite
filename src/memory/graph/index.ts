/**
 * Public API for the flat-file graph memory system.
 */

// Store
export { ensureGraphDir, getGraphDir, getNodesPath, getEdgesPath } from "./store.js"
export { readNodes, writeNodes, readEdges, writeEdges } from "./store.js"

// Episode
export { createEpisode, getEpisode, getEpisodesBySource, getEpisodesByRun, getNextEpisodeSeq } from "./episode.js"

// Queries
export {
  getCurrentFacts,
  getFactsAtTime,
  getFactById,
  getFactHistory,
  searchFacts,
  getOutgoingEdges,
  getIncomingEdges,
  getRelatedFacts,
  getFactProvenance,
  writeFact,
  updateFact,
  invalidateFact,
  writeEdge,
  invalidateEdge,
} from "./queries.js"

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
  nodeId,
  nodeIdWithTimestamp,
  edgeId,
  episodeId,
} from "./types.js"
