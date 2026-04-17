/**
 * Default confidence values for facts by their source.
 *
 * Confidence is a soft signal the LLM can use to weight recommendations.
 * User-stated facts are authoritative (1.0); machine-extracted ones taper
 * based on how close to the source of truth they are.
 *
 * Callers may override by passing an explicit confidence to writeFact.
 */

import type { EpisodeSource } from "./types.js"

export const SOURCE_CONFIDENCE: Record<EpisodeSource, number> = {
  user_feedback: 1.0,
  retraction: 1.0,
  review: 0.9,
  migration: 0.8,
  ci_failure: 0.75,
  stage_diary: 0.7,
  plan: 0.65,
  decompose: 0.65,
  nudge: 0.6,
}

export function defaultConfidenceFor(source: EpisodeSource): number {
  return SOURCE_CONFIDENCE[source] ?? 0.5
}

/**
 * Clamp a user-provided confidence to [0, 1]. Returns undefined if input
 * isn't a finite number — callers can then fall back to source default.
 */
export function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}
