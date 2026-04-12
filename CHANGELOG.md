# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Add new entries above. Do not edit below this line. -->

## [0.1.52] - 2026-04-09

### Fixed

- **FTS search broken for single/multi-doc corpora**: Fixed BM25 IDF formula that was producing negative scores. Root cause was `totalDocs++` being called after the IDF recompute loop, so `totalDocs=0` was used in `log((N+1)/(df+1))` → `log(1/2) = -0.693` for all terms. Also added `+1` smoothing so IDF never reaches zero for single-doc corpora.
- **`rebuildIndex` broken**: Was calling `indexEpisode()` which re-read the corrupted index instead of building fresh from episode files. Now correctly rebuilds from disk.
- **`removeFromIndex` stale IDF**: After removing a document, IDF values were not recomputed. Now recomputes IDF after doc removal.
- **`rebuildIndex` test**: Fixed test that didn't write episode file to disk (needed by `rebuildIndex` which reads from episode files, not the index).
- **Pipeline mock runner**: Added missing `verify` stage JSON response to mock runner in integration tests.

### Added

- **Integration test coverage**: Added 12 FTS search tests, 4 pipeline graph commit tests, 8 nudge backfill tests, 16 watch schedule tests.
