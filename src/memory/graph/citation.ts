/**
 * Citation parsing for stage output.
 *
 * When the LLM generates text that references a project-memory fact, it's
 * asked to cite the fact ID in square brackets, e.g. `[fact_conventions_auth_12345]`.
 * This module extracts those citations from an arbitrary block of text so
 * the pipeline can log which facts actually influenced behavior.
 */

export const CITATION_INSTRUCTION =
  "When a recommendation in your output is grounded in a Project Memory entry, " +
  "cite the fact's id inline in square brackets — e.g. [fact_conventions_auth_1234]. " +
  "Citations let the engine verify that memory is useful; they're optional but " +
  "strongly preferred."

const CITATION_RE = /\[(fact_[a-zA-Z0-9_-]+)\]/g

/**
 * Extract all `[fact_*]` citation tokens from `text`. Dedupes, preserves
 * first-occurrence order. Returns an empty array for empty / undefined input.
 */
export function extractCitations(text: string | undefined | null): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(CITATION_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}
