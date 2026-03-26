# Contributing to Kody Engine Lite

## Prerequisites

- **Node 22+**
- **pnpm** (`npm install -g pnpm`)
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`) — used by the engine at runtime
- **gh CLI** — for GitHub operations during pipeline runs

## Dev Setup

```bash
git clone https://github.com/kody-ade/kody-engine-lite
cd kody-engine-lite
pnpm install
```

### Verify your setup

```bash
pnpm typecheck   # TypeScript type check
pnpm test        # Run all tests
pnpm build       # Build dist/
```

### Run locally against a project

```bash
# Run a task in dry-run mode (no agent calls)
pnpm kody run --task "Add feature X" --dry-run

# Run against a real project
pnpm kody run --task "Add feature X" --cwd /path/to/your-project
```

## Making Changes

1. Fork the repo and create a branch: `git checkout -b feat/my-change`
2. Make your changes following the conventions below
3. Run `pnpm typecheck && pnpm test` — both must pass
4. Commit using [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
5. Open a PR against `main`

## Code Conventions

- **TypeScript strict mode** — no implicit `any`, full type coverage
- **ES2022 modules** — use `import`/`export`, top-level `await` where needed
- **Immutability** — prefer spread operators over mutation
- **Error handling** — use try/catch with structured logging (`src/logger.ts`)
- **No side effects at module level** — all initialization inside functions

## Project Structure

```
src/
├── entry.ts          — CLI argument parsing, pipeline dispatch
├── state-machine.ts  — Pipeline orchestration loop
├── definitions.ts    — 7-stage pipeline configuration
├── agent-runner.ts   — Claude Code subprocess wrapper
├── context.ts        — Prompt assembly + task context injection
├── config.ts         — Config loading (kody.config.json)
├── git-utils.ts      — Git operations
├── github-api.ts     — GitHub API via gh CLI
└── bin/cli.ts        — Package CLI (init, run, rerun, fix, status)
prompts/              — Stage prompt templates (Markdown)
templates/            — GitHub Actions workflow template
tests/                — Vitest unit tests
```

See [ONBOARDING.md](ONBOARDING.md) for a full walkthrough of the architecture and design decisions.

## Testing

Tests live in `tests/` and run with Vitest:

```bash
pnpm test              # run all tests
pnpm test -- --watch   # watch mode
```

Write tests for any new logic in `src/`. Tests use mocked file system and process calls — avoid real I/O in unit tests.

## Reporting Issues

Open a GitHub issue. Include:
- What you ran (CLI command or comment trigger)
- What happened vs. what you expected
- Relevant logs (set `LOG_LEVEL=debug` for verbose output)
