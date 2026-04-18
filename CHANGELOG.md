# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Add new entries above. Do not edit below this line. -->

## [0.4.4] - 2026-04-18

### Fixed

- **fix-mode no-op when human adds feedback**: `@kody fix` with a non-empty feedback body silently produced zero source changes. Three interacting bugs:
  - `prompts/build.md` instructed the build agent to "follow the plan EXACTLY"; with fix-mode skipping `plan`, the agent treated the existing task.md/plan.md as complete and ignored the `## Human Feedback` section. Added rule #8 making Human Feedback authoritative scope when present.
  - `detectSourceChangesVsBase` in `src/stages/ship.ts` diffed PR HEAD against the default branch, so pre-existing PR changes always masked a no-op fix run. Now captures `preFixHead` at fix-run start in `src/entry.ts` and diffs `preFixHead...HEAD` via new `detectSourceChangesSinceRef`; falls back to base when unavailable.
  - `findLastKodyActionTimestamp` in `src/github-api.ts` used the latest Kody comment as the "last action" cutoff — but Kody posts "Kody pipeline started" seconds before `getPRFeedbackSinceLastKodyAction` runs, so the human comment that triggered the run got filtered out. Added a 60s exclusion window so same-run Kody comments don't shadow the triggering feedback.

### Added

- Unit tests: `tests/unit/pr-feedback-timestamp.test.ts` (8 cases covering `isKodyComment` + `findLastKodyActionTimestamp` exclusion window), extended `tests/unit/ship-guard.test.ts` with `detectSourceChangesSinceRef` cases (no-op fix, real source change, pure `.kody/` artifact commit, unknown-ref safety net).
- Public exports: `detectSourceChangesSinceRef`, `isKodyComment`, `findLastKodyActionTimestamp`, `RECENT_KODY_COMMENT_EXCLUSION_MS`.

## [0.1.52] - 2026-04-09

### Fixed

- **FTS search broken for single/multi-doc corpora**: Fixed BM25 IDF formula that was producing negative scores. Root cause was `totalDocs++` being called after the IDF recompute loop, so `totalDocs=0` was used in `log((N+1)/(df+1))` → `log(1/2) = -0.693` for all terms. Also added `+1` smoothing so IDF never reaches zero for single-doc corpora.
- **`rebuildIndex` broken**: Was calling `indexEpisode()` which re-read the corrupted index instead of building fresh from episode files. Now correctly rebuilds from disk.
- **`removeFromIndex` stale IDF**: After removing a document, IDF values were not recomputed. Now recomputes IDF after doc removal.
- **`rebuildIndex` test**: Fixed test that didn't write episode file to disk (needed by `rebuildIndex` which reads from episode files, not the index).
- **Pipeline mock runner**: Added missing `verify` stage JSON response to mock runner in integration tests.

### Added

- **Integration test coverage**: Added 12 FTS search tests, 4 pipeline graph commit tests, 8 nudge backfill tests, 16 watch schedule tests.
