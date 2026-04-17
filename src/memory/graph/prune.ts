/**
 * Archive invalidated facts older than a cutoff.
 *
 * Nodes where `validTo !== null && validTo < cutoff` are moved to
 * `.kody/graph/archived.json`. Edges that reference only archived nodes
 * (both endpoints archived) are cascade-archived too; edges with one live
 * endpoint are kept.
 *
 * Reversible: the archived file is a full-fidelity mirror. Restoring
 * manually via `jq` or a future `kody graph unarchive` is straightforward.
 */

import * as fs from "fs"
import * as path from "path"

import {
  readNodes,
  writeNodes,
  readEdges,
  writeEdges,
  getGraphDir,
  atomicWrite,
} from "./store.js"
import { withGraphLockSync } from "./lock.js"
import type { GraphNode, GraphEdge } from "./types.js"

export interface PruneReport {
  cutoff: string
  nodesArchived: number
  edgesArchived: number
  nodesRemaining: number
  edgesRemaining: number
  archivedFile: string
}

interface ArchivedPayload {
  version: 1
  cutoff: string
  archivedAt: string
  nodes: Record<string, GraphNode>
  edges: GraphEdge[]
}

function getArchivedPath(projectDir: string): string {
  return path.join(getGraphDir(projectDir), "archived.json")
}

/**
 * Archive invalidated nodes whose validTo is older than `sinceDays` ago.
 * When `dryRun: true`, returns counts without touching files.
 */
export function pruneInvalidatedOlderThan(
  projectDir: string,
  sinceDays: number,
  opts: { dryRun?: boolean } = {},
): PruneReport {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
  const archivedPath = getArchivedPath(projectDir)

  if (opts.dryRun) {
    const nodes = readNodes(projectDir)
    const edges = readEdges(projectDir)
    const archivedIds = new Set(
      Object.values(nodes)
        .filter((n) => n.validTo !== null && n.validTo < cutoff)
        .map((n) => n.id),
    )
    const archivedEdgeCount = edges.filter(
      (e) => archivedIds.has(e.from) && archivedIds.has(e.to),
    ).length
    return {
      cutoff,
      nodesArchived: archivedIds.size,
      edgesArchived: archivedEdgeCount,
      nodesRemaining: Object.keys(nodes).length - archivedIds.size,
      edgesRemaining: edges.length - archivedEdgeCount,
      archivedFile: archivedPath,
    }
  }

  return withGraphLockSync(projectDir, () => {
    const nodes = readNodes(projectDir)
    const edges = readEdges(projectDir)

    const toArchiveNodes: Record<string, GraphNode> = {}
    const liveNodes: Record<string, GraphNode> = {}
    for (const [id, node] of Object.entries(nodes)) {
      if (node.validTo !== null && node.validTo < cutoff) {
        toArchiveNodes[id] = node
      } else {
        liveNodes[id] = node
      }
    }

    const archivedIds = new Set(Object.keys(toArchiveNodes))
    const toArchiveEdges: GraphEdge[] = []
    const liveEdges: GraphEdge[] = []
    for (const edge of edges) {
      if (archivedIds.has(edge.from) && archivedIds.has(edge.to)) {
        toArchiveEdges.push(edge)
      } else {
        liveEdges.push(edge)
      }
    }

    const nArchived = archivedIds.size
    const eArchived = toArchiveEdges.length

    if (nArchived > 0 || eArchived > 0) {
      // Merge into existing archived.json if present (don't clobber).
      let existing: ArchivedPayload | null = null
      if (fs.existsSync(archivedPath)) {
        try {
          const raw = fs.readFileSync(archivedPath, "utf-8")
          existing = JSON.parse(raw) as ArchivedPayload
        } catch {
          existing = null
        }
      }
      const merged: ArchivedPayload = {
        version: 1,
        cutoff,
        archivedAt: new Date().toISOString(),
        nodes: { ...(existing?.nodes ?? {}), ...toArchiveNodes },
        edges: [...(existing?.edges ?? []), ...toArchiveEdges],
      }
      atomicWrite(archivedPath, merged)

      writeNodes(projectDir, liveNodes)
      writeEdges(projectDir, liveEdges)
    }

    return {
      cutoff,
      nodesArchived: nArchived,
      edgesArchived: eArchived,
      nodesRemaining: Object.keys(liveNodes).length,
      edgesRemaining: liveEdges.length,
      archivedFile: archivedPath,
    }
  })
}
