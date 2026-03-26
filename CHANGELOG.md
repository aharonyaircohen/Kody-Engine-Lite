# Changelog

All notable changes to Kody Engine Lite are documented here.

## [0.1.x] — 2025–2026

### Added

- **Claude Code runner** — switched primary runner to Claude Code CLI for full tool-use support (`--print` mode)
- **PR description generation** — ship stage generates structured PR descriptions with What/Scope/Changes sections and plan as collapsible details
- **Approve flow (question gate)** — Kody can pause and post clarifying questions; resume with `@kody approve` and answers injected as context
- **Fix command** — `@kody fix` and `kody-engine-lite fix` re-run from build stage, skipping taskify/plan; supports `--feedback` for targeted guidance
- **Branch syncing** — on every run/rerun/fix, auto-merges default branch into the feature branch before building
- **Smart init** — LLM-powered project analysis generates `kody.config.json` and `.kody/memory/` files from existing project structure
- **Complexity-based stage skipping** — `low`/`medium`/`high` complexity controls which stages run; auto-detected from taskify output
- **Multi-runner support** — configure different agent runners per stage (e.g., Claude Code for build, OpenCode for plan/review)
- **OpenCode runner** — supports MiniMax, OpenAI, Anthropic, Gemini via OpenCode CLI
- **Rich PR metadata** — type/risk labels (`kody:feature`, `kody:high`), skipped stage explanation in PR body
- **Question gates** — taskify asks product questions, plan asks architecture questions before proceeding
- **Auto task-id generation** — `@kody` without a task-id generates one automatically
- **Pipeline start comment** — posts a comment when the pipeline begins so the issue thread shows progress
- **Rerun without task-id** — `@kody rerun` auto-detects the latest task for the issue
- **LiteLLM proxy support** — route models through LiteLLM for multi-provider fallback
- **Memory system** — `.kody/memory/architecture.md` and `conventions.md` prepended to every agent prompt
- **7-stage pipeline** — taskify → plan → build → verify → review → review-fix → ship
- **Verify + autofix loop** — if verify fails, runs lint-fix + format-fix + autofix agent, retries up to 2 times
- **Review + fix loop** — if review verdict is FAIL, runs review-fix then re-reviews
- **State persistence** — `.tasks/<task-id>/status.json` tracks per-stage state for resume
- **GitHub Actions workflow template** — `kody-engine-lite init` copies `kody.yml` into your repo
- **Status command** — `kody-engine-lite status --task-id <id>` shows pipeline progress
- **Dry-run mode** — `--dry-run` skips agent calls for testing configuration

### Fixed

- Rerun without `status.json` falls back to full pipeline with feedback preserved
- OpenCode runner uses `--agent build` for full tool permissions in CI
- `GH_TOKEN` used for PR branch checkout; `findLatestTask` filters directories only
- Approve flow resumes paused task; PR title prefixed with conventional commit type
- Paused pipeline does not post failure comment or exit with error
- Deterministic config validation after LLM generation — overrides with exact `package.json` script matches

### Changed

- Switched from OpenCode to Claude Code as the default runner (OpenCode has single-shot limitations)
- `outDir` for tsup build is `dist/bin/` with cli.js as the sole entry; entry.ts loaded via dynamic import

---

Future releases will use [conventional-changelog](https://github.com/conventional-changelog/conventional-changelog) to generate entries automatically.
