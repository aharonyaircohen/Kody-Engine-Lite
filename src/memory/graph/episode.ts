/**
 * Episode management.
 *
 * Episodes are stored in:
 *   .kody/graph/episodes/<episodeId>.json
 *
 * Sequence numbers are tracked in:
 *   .kody/graph/episodes/.seq
 *   Format: { "review": 42, "ci_failure": 7, ... }
 */

import * as fs from "fs"
import * as path from "path"
import { ensureGraphDir, getGraphDir } from "./store.js"

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
    return {}
  }
}

function writeSeqMap(projectDir: string, seq: SeqMap): void {
  const filePath = getSeqPath(projectDir)
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(seq, null, 2), "utf-8")
  fs.renameSync(tmp, filePath)
}

/** Get the next sequence number for a source, incrementing atomically */
export function getNextEpisodeSeq(projectDir: string, source: EpisodeSource): number {
  ensureGraphDir(projectDir)
  const seq = readSeqMap(projectDir)
  const next = (seq[source] ?? 0) + 1
  seq[source] = next
  writeSeqMap(projectDir, seq)
  return next
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
  ensureGraphDir(projectDir)

  const seq = getNextEpisodeSeq(projectDir, data.source)
  const id = episodeId(data.source, seq)

  const episode: Episode = { id, ...data }

  const filePath = getEpisodePath(projectDir, id)
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(episode, null, 2), "utf-8")
  fs.renameSync(tmp, filePath)

  // Index in the session search layer
  indexEpisode(projectDir, episode)

  return episode
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
