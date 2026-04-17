/**
 * Episode management.
 *
 * Episodes are stored in:
 *   .kody/graph/episodes/<episodeId>.json
 *
 * Sequence numbers are tracked in:
 *   .kody/graph/episodes/.seq
 *   Format: { "review": 42, "ci_failure": 7, ... }
 *
 * Concurrency: getNextEpisodeSeq holds the graph write lock so that two
 * concurrent callers cannot assign the same sequence number. Individual
 * episode files have unique names and are written atomically, so they do
 * not contend.
 */

import * as fs from "fs"
import * as path from "path"
import { ensureGraphDir, getGraphDir, atomicWrite } from "./store.js"
import { withGraphLockSync } from "./lock.js"
import { traced } from "./trace.js"

// Re-export ensureGraphDir so tests can import from episode.ts
export { ensureGraphDir }
import type { Episode, EpisodeSource } from "./types.js"
import { episodeId } from "./types.js"
import { indexEpisode } from "../search.js"

// ─── Sequence Tracking ─────────────────────────────────────────────────────────

const SEQ_FILE = ".seq"

interface SeqMap {
  [source: string]: number
}

function getSeqPath(projectDir: string): string {
  return path.join(getGraphDir(projectDir), "episodes", SEQ_FILE)
}

function readSeqMap(projectDir: string): SeqMap {
  const filePath = getSeqPath(projectDir)
  if (!fs.existsSync(filePath)) return {}

  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(raw) as SeqMap
  } catch {
    // Seq map corruption is recoverable — treat as empty. Worst case we
    // generate a duplicate id and log on write. A .bak round-trip is
    // overkill for a counter file.
    return {}
  }
}

function writeSeqMap(projectDir: string, seq: SeqMap): void {
  atomicWrite(getSeqPath(projectDir), seq)
}

/** Get the next sequence number for a source, incrementing atomically */
export function getNextEpisodeSeq(projectDir: string, source: EpisodeSource): number {
  ensureGraphDir(projectDir)
  return withGraphLockSync(projectDir, () => {
    const seq = readSeqMap(projectDir)
    const next = (seq[source] ?? 0) + 1
    seq[source] = next
    writeSeqMap(projectDir, seq)
    return next
  })
}

// ─── Episode Files ─────────────────────────────────────────────────────────────

function getEpisodePath(projectDir: string, episodeIdVal: string): string {
  return path.join(getGraphDir(projectDir), "episodes", `${episodeIdVal}.json`)
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createEpisode(
  projectDir: string,
  data: Omit<Episode, "id">,
): Episode {
  return traced("createEpisode", () => {
    ensureGraphDir(projectDir)

    const seq = getNextEpisodeSeq(projectDir, data.source)
    const id = episodeId(data.source, seq)

    const episode: Episode = { id, ...data }

    // Episode filenames are unique by construction (unique seq), so
    // atomicWrite alone is enough — no graph lock needed.
    atomicWrite(getEpisodePath(projectDir, id), episode)

    // Index in the session search layer
    indexEpisode(projectDir, episode)

    return episode
  })
}

export function getEpisode(projectDir: string, episodeIdVal: string): Episode | null {
  const filePath = getEpisodePath(projectDir, episodeIdVal)
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(raw) as Episode
  } catch {
    return null
  }
}

/**
 * Atomically read-modify-write an existing episode. Used by nudge to
 * backfill extractedNodeIds after its node writes.
 *
 * Held under the graph lock so that concurrent updaters serialize.
 */
export function updateEpisode(
  projectDir: string,
  episodeIdVal: string,
  patch: Partial<Omit<Episode, "id">>,
): Episode | null {
  return withGraphLockSync(projectDir, () => {
    const existing = getEpisode(projectDir, episodeIdVal)
    if (!existing) return null
    const updated: Episode = { ...existing, ...patch, id: existing.id }
    atomicWrite(getEpisodePath(projectDir, episodeIdVal), updated)
    return updated
  })
}

export function getEpisodesBySource(
  projectDir: string,
  source: EpisodeSource,
): Episode[] {
  const episodesDir = path.join(getGraphDir(projectDir), "episodes")
  if (!fs.existsSync(episodesDir)) return []

  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith(".json") && f !== SEQ_FILE)
  const results: Episode[] = []

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(episodesDir, file), "utf-8")
      const ep = JSON.parse(raw) as Episode
      if (ep.source === source) {
        results.push(ep)
      }
    } catch {
      // Skip corrupt files
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id))
}

export function getEpisodesByRun(projectDir: string, runId: string): Episode[] {
  const episodesDir = path.join(getGraphDir(projectDir), "episodes")
  if (!fs.existsSync(episodesDir)) return []

  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith(".json") && f !== SEQ_FILE)
  const results: Episode[] = []

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(episodesDir, file), "utf-8")
      const ep = JSON.parse(raw) as Episode
      if (ep.runId === runId) {
        results.push(ep)
      }
    } catch {
      // Skip corrupt files
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id))
}
