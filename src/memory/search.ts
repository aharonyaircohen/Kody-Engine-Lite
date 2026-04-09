/**
 * Session search layer — FTS5-style full-text search over episodes.
 *
 * Uses a zero-dependency inverted index with BM25-style ranking.
 * Stored as a flat JSON file in .kody/graph/sessions-index.json.
 *
 * Index structure:
 * {
 *   "vocabulary": { "word": { docCount, docFreq, idf } },
 *   "documents": { "docId": { taskId, episodeId, source, content, createdAt, wordCount } }
 * }
 */

import * as fs from "fs"
import * as path from "path"

import { getGraphDir } from "./graph/store.js"
import type { Episode } from "./graph/types.js"

const INDEX_FILE = "sessions-index.json"
const AVG_DOC_LEN = 200 // chars — used for BM25 length normalization

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  taskId: string
  episodeId: string
  source: string
  score: number   // BM25 score
  snippet: string  // highlighted excerpt
  createdAt: string
}

interface VocabularyEntry {
  docCount: number    // number of docs this word appears in
  idf: number         // inverse document frequency
}

interface IndexedDoc {
  taskId: string
  episodeId: string
  source: string
  content: string
  createdAt: string
  wordCount: number
  positions: number[]  // byte offsets of word occurrences in content
}

// ─── Index Path ───────────────────────────────────────────────────────────────

function getIndexPath(projectDir: string): string {
  return path.join(getGraphDir(projectDir), INDEX_FILE)
}

// ─── Tokenization ─────────────────────────────────────────────────────────────

/** Simple tokenizer: lowercase, split on non-alphanumeric, drop stopwords */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
  "be", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "this", "that", "these", "those", "it",
  "its", "they", "them", "their", "what", "which", "who", "whom", "if",
  "then", "else", "when", "where", "why", "how", "all", "each", "every",
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
}

function getWordPositions(content: string, words: Set<string>): number[] {
  const positions: number[] = []
  const lower = content.toLowerCase()
  for (const word of words) {
    let idx = 0
    while (true) {
      const pos = lower.indexOf(word, idx)
      if (pos === -1) break
      // Only count if it's a whole-word match
      const before = pos === 0 || /[^a-z0-9]/.test(lower[pos - 1]!)
      const after  = pos + word.length >= lower.length || /[^a-z0-9]/.test(lower[pos + word.length]!)
      if (before && after) positions.push(pos)
      idx = pos + 1
    }
  }
  return positions.sort((a, b) => a - b)
}

// ─── BM25 ─────────────────────────────────────────────────────────────────────

const BM25_K1 = 1.5
const BM25_B  = 0.75

function bm25Score(
  termFreq: number,
  docLen: number,
  idf: number,
  avgDocLen: number,
): number {
  const numerator   = termFreq * (BM25_K1 + 1)
  const denominator = termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen))
  return idf * (numerator / denominator)
}

// ─── Snippet Generation ───────────────────────────────────────────────────────

function generateSnippet(content: string, positions: number[], queryWords: string[], maxLen = 200): string {
  if (positions.length === 0) return content.slice(0, maxLen)

  // Start snippet around the first match
  const startPos = Math.max(0, positions[0] - 60)
  const raw = content.slice(startPos, startPos + maxLen)

  // Highlight query terms
  let snippet = raw
  for (const word of queryWords) {
    const regex = new RegExp(`\\b${word}\\b`, "gi")
    snippet = snippet.replace(regex, "**$&**")
  }

  return (startPos > 0 ? "..." : "") + snippet + (startPos + maxLen < content.length ? "..." : "")
}

// ─── Index Operations ─────────────────────────────────────────────────────────

function readIndex(projectDir: string): {
  vocabulary: Record<string, VocabularyEntry>
  documents: Record<string, IndexedDoc>
  totalDocs: number
} {
  const filePath = getIndexPath(projectDir)
  if (!fs.existsSync(filePath)) return { vocabulary: {}, documents: {}, totalDocs: 0 }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return { vocabulary: {}, documents: {}, totalDocs: 0 }
  }
}

function writeIndex(
  projectDir: string,
  index: { vocabulary: Record<string, VocabularyEntry>; documents: Record<string, IndexedDoc>; totalDocs: number },
): void {
  const dir = getGraphDir(projectDir)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = getIndexPath(projectDir) + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(index), "utf-8")
  fs.renameSync(tmp, getIndexPath(projectDir))
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Index an episode into the search index.
 * Called by createEpisode() in episode.ts.
 */
export function indexEpisode(projectDir: string, episode: Episode): void {
  const content = episode.rawContent
  const words   = tokenize(content)
  const wordSet = new Set(words)
  const positions = getWordPositions(content, wordSet)

  const index = readIndex(projectDir)
  const docId  = episode.id

  const doc: IndexedDoc = {
    taskId:    episode.taskId,
    episodeId: episode.id,
    source:    episode.source,
    content,
    createdAt: episode.createdAt,
    wordCount: content.length, // chars used as proxy for doc length
    positions,
  }

  // Update vocabulary: docCount and IDF
  const uniqueWords = [...wordSet]
  for (const word of uniqueWords) {
    const tf = words.filter(w => w === word).length
    if (!index.vocabulary[word]) {
      index.vocabulary[word] = { docCount: 0, idf: 0 }
    }
    index.vocabulary[word].docCount++
  }

  // Recompute IDF for all words (cheap enough for small-to-medium corpora)
  for (const word of Object.keys(index.vocabulary)) {
    const dc = index.vocabulary[word].docCount
    index.vocabulary[word].idf = Math.log((index.totalDocs + 1) / (dc + 1))
  }

  index.documents[docId] = doc
  index.totalDocs++

  writeIndex(projectDir, index)
}

/**
 * Full-text search over all indexed episodes.
 * Returns ranked results using BM25.
 */
export function searchSessions(
  projectDir: string,
  query: string,
  limit = 10,
): SearchResult[] {
  const index = readIndex(projectDir)
  if (index.totalDocs === 0) return []

  const queryWords = tokenize(query)
  if (queryWords.length === 0) return []

  const scores: Array<SearchResult & { _docId: string }> = []

  for (const [docId, doc] of Object.entries(index.documents)) {
    let totalScore = 0
    for (const word of queryWords) {
      const vocab = index.vocabulary[word]
      if (!vocab) continue

      const termFreq = doc.content.toLowerCase().split(/\s+/).filter(w => w === word).length
      totalScore += bm25Score(termFreq, doc.wordCount, vocab.idf, AVG_DOC_LEN)
    }

    if (totalScore > 0) {
      const snippet = generateSnippet(doc.content, doc.positions, queryWords)
      scores.push({
        _docId:    docId,
        taskId:    doc.taskId,
        episodeId: doc.episodeId,
        source:    doc.source,
        score:     Math.round(totalScore * 100) / 100,
        snippet,
        createdAt: doc.createdAt,
      })
    }
  }

  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Remove a document from the index.
 */
export function removeFromIndex(projectDir: string, episodeId: string): void {
  const index = readIndex(projectDir)
  if (!index.documents[episodeId]) return

  const removed = index.documents[episodeId]
  const words = tokenize(removed.content)
  const wordSet = new Set(words)

  for (const word of wordSet) {
    if (index.vocabulary[word]) {
      index.vocabulary[word].docCount = Math.max(0, index.vocabulary[word].docCount - 1)
    }
  }

  delete index.documents[episodeId]
  index.totalDocs = Math.max(0, index.totalDocs - 1)

  writeIndex(projectDir, index)
}

/**
 * Rebuild the entire index from all episodes on disk.
 * Useful after a migration or if the index file is corrupted.
 */
export function rebuildIndex(projectDir: string): void {
  const graphDir = getGraphDir(projectDir)
  const episodesDir = path.join(graphDir, "episodes")
  if (!fs.existsSync(episodesDir)) return

  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith(".json") && f !== ".seq")
  const freshIndex = { vocabulary: {}, documents: {}, totalDocs: 0 }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(episodesDir, file), "utf-8")
      const episode: Episode = JSON.parse(raw)
      indexEpisode(projectDir, episode)
    } catch {
      // Skip corrupt episode files
    }
  }
}
