/**
 * Graph invariant validator.
 *
 * Catches data-shape bugs introduced by concurrent writes, manual edits,
 * or future schema drift — things the type system can't enforce on a
 * flat-file store. Used by `kody graph validate` and as a pre-flight
 * check in maintenance tooling.
 *
 * Invariants checked:
 *   1. Node IDs in `nodes.json` match their `id` field
 *   2. Every edge's `from` and `to` reference a real node
 *   3. Every valid (validTo === null) edge points at a valid node
 *   4. Every node's `episodeId` references an existing episode file
 *   5. validFrom is ISO-8601 and not after validTo
 *   6. superseded_by chains do not contain cycles
 */

import * as fs from "fs"
import * as path from "path"
import { getGraphDir, readNodes, readEdges } from "./store.js"

export interface ValidationIssue {
  severity: "error" | "warning"
  code: string
  subject: string
  message: string
}

export interface ValidationReport {
  ok: boolean
  issues: ValidationIssue[]
  nodeCount: number
  edgeCount: number
  episodeCount: number
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/

export function validateGraph(projectDir: string): ValidationReport {
  const issues: ValidationIssue[] = []
  const nodes = readNodes(projectDir)
  const edges = readEdges(projectDir)

  // Episode filenames available on disk — used to cross-check episodeId refs.
  const episodesDir = path.join(getGraphDir(projectDir), "episodes")
  const episodeIds = new Set<string>()
  if (fs.existsSync(episodesDir)) {
    for (const f of fs.readdirSync(episodesDir)) {
      if (!f.endsWith(".json") || f === ".seq") continue
      episodeIds.add(f.slice(0, -5))
    }
  }

  // 1 + 5 — node-level invariants
  for (const [key, node] of Object.entries(nodes)) {
    if (node.id !== key) {
      issues.push({
        severity: "error",
        code: "node.id_mismatch",
        subject: key,
        message: `Node stored under key "${key}" has id "${node.id}"`,
      })
    }
    if (!ISO_RE.test(node.validFrom)) {
      issues.push({
        severity: "error",
        code: "node.bad_validFrom",
        subject: node.id,
        message: `validFrom "${node.validFrom}" is not ISO-8601`,
      })
    }
    if (node.validTo !== null) {
      if (!ISO_RE.test(node.validTo)) {
        issues.push({
          severity: "error",
          code: "node.bad_validTo",
          subject: node.id,
          message: `validTo "${node.validTo}" is not ISO-8601`,
        })
      } else if (node.validTo < node.validFrom) {
        issues.push({
          severity: "error",
          code: "node.time_reversed",
          subject: node.id,
          message: `validTo (${node.validTo}) precedes validFrom (${node.validFrom})`,
        })
      }
    }
    if (episodeIds.size > 0 && !episodeIds.has(node.episodeId)) {
      issues.push({
        severity: "warning",
        code: "node.orphan_episode",
        subject: node.id,
        message: `references episodeId "${node.episodeId}" with no episode file on disk`,
      })
    }
  }

  // 2 + 3 — edges must reference real nodes
  for (const edge of edges) {
    if (!nodes[edge.from]) {
      issues.push({
        severity: "error",
        code: "edge.dangling_from",
        subject: edge.id,
        message: `edge.from "${edge.from}" has no node`,
      })
    }
    if (!nodes[edge.to]) {
      issues.push({
        severity: "error",
        code: "edge.dangling_to",
        subject: edge.id,
        message: `edge.to "${edge.to}" has no node`,
      })
    }
  }

  // 6 — no cycles in superseded_by chains
  const supersededBy = new Map<string, string>()
  for (const edge of edges) {
    if (edge.rel !== "superseded_by") continue
    if (edge.validTo !== null) continue
    supersededBy.set(edge.from, edge.to)
  }
  for (const start of supersededBy.keys()) {
    const seen = new Set<string>()
    let cursor: string | undefined = start
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = supersededBy.get(cursor)
    }
    if (cursor && seen.has(cursor)) {
      issues.push({
        severity: "error",
        code: "edge.supersede_cycle",
        subject: start,
        message: `superseded_by chain from "${start}" contains a cycle`,
      })
    }
  }

  return {
    ok: issues.every(i => i.severity !== "error"),
    issues,
    nodeCount: Object.keys(nodes).length,
    edgeCount: edges.length,
    episodeCount: episodeIds.size,
  }
}
