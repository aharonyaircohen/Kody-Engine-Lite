# Kody-Engine-Lite — Agent Onboarding Prompt

## What is this project?

Kody-Engine-Lite is an **autonomous SDLC pipeline** that runs as an npm package. Users comment `@kody` on a GitHub issue, and Kody automatically: classifies the task, creates a plan, builds code, runs quality gates, reviews its own code, fixes issues, and creates a PR — all without human intervention.

## Architecture

```
@kody comment on GitHub issue
     ↓
GitHub Actions workflow (templates/kody.yml)
     ↓
kody-engine-lite CLI (npm package)
     ↓
7-stage pipeline: taskify → plan → build → verify → review → review-fix → ship
     ↓
Agent Runner (Claude Code or OpenCode) executes each stage
     ↓
PR created with Closes #N
```

**Key design principle:** Kody (the orchestrator) is intentionally dumb. It runs stages in order, persists state, and spawns agents. All intelligence lives in Claude Code / OpenCode + the prompt templates.

**Agent Runner is a thin subprocess wrapper.** It spawns a CLI, pipes a prompt, enforces timeout, returns output. It does NOT reason, manage context, or make decisions.

## Tech Stack

- **Language:** TypeScript (strict mode, ESM)
- **Runtime:** Node.js 22+
- **Package manager:** pnpm
- **Build:** tsup (bundles src/bin/cli.ts → dist/bin/cli.js)
- **Tests:** Vitest (126 tests, 16 files)
- **Linting:** ESLint (not configured in Lite itself, but quality gates run target project's linter)
- **CI:** GitHub Actions (.github/workflows/ci.yml for Lite's own CI)
- **npm package:** @kody-ade/kody-engine-lite (published to npm, currently v0.1.17)

## Repository Structure

```
src/
├── entry.ts              — CLI entry: run/rerun/fix/status commands, arg parsing, CI mode
├── types.ts              — All TypeScript interfaces (AgentRunner, PipelineContext, etc.)
├── definitions.ts        — 7-stage pipeline config (name, type, modelTier, timeout)
├── state-machine.ts      — Pipeline orchestration loop (THE core file, ~700 lines)
├── agent-runner.ts       — Claude Code + OpenCode subprocess runners
├── context.ts            — Prompt assembly: read prompts, inject task context + memory
├── memory.ts             — Read .kody/memory/*.md files
├── config.ts             — Load kody.config.json, pipeline constants
├── logger.ts             — Simple structured logger with CI group support
├── validators.ts         — Validate taskify JSON, plan markdown, review markdown
├── verify-runner.ts      — Quality gate execution (typecheck, lint, test)
├── git-utils.ts          — Git operations (branch, commit, push, diff, sync)
├── github-api.ts         — GitHub API via gh CLI (issues, labels, PRs, comments)
├── kody-utils.ts         — Task directory utilities
├── preflight.ts          — Startup health checks
├── bin/cli.ts            — Package CLI entry (init, run, version) — NOT bundled with entry.ts
└── ci/
    ├── parse-safety.ts   — Validate GitHub comment author
    └── parse-inputs.ts   — Parse @kody comment syntax

prompts/                  — Stage prompt templates (taskify.md, plan.md, build.md, etc.)
templates/                — GitHub Actions workflow template (copied by init)
tests/
├── unit/                 — 14 test files
└── int/                  — 2 integration test files
plans/                    — Phase planning docs (internal, not user-facing)
```

## Key Files to Understand First

1. **`src/state-machine.ts`** — The heart. Pipeline loop, stage dispatch, verify+autofix loop, review+fix loop, question gates, complexity filtering, auto-learn, PR body generation, ship stage.
2. **`src/entry.ts`** — CLI interface. Handles run/rerun/fix/status, auto-generates task IDs, fetches issue body, finds paused tasks, posts comments.
3. **`src/agent-runner.ts`** — Runner factory. Creates Claude Code or OpenCode runners. The `AgentRunner` interface is the swappable abstraction.
4. **`src/bin/cli.ts`** — Package entry. Smart init (LLM-powered project analysis), health checks, label creation.
5. **`templates/kody.yml`** — Workflow template installed in target repos. Parse job, orchestrate job, error notifications, smoke test.

## The 7-Stage Pipeline

| Stage | Type | Model | What it does |
|-------|------|-------|-------------|
| taskify | agent | cheap (haiku) | Classify task → task.json (type, title, scope, risk, questions) |
| plan | agent | strong (opus) | Create TDD implementation plan → plan.md |
| build | agent | mid (sonnet) | Implement code using Claude Code tools |
| verify | gate | — | Run typecheck + tests + lint from kody.config.json |
| review | agent | strong (opus) | Code review → review.md (PASS/FAIL + findings) |
| review-fix | agent | mid (sonnet) | Fix Critical/Major review findings |
| ship | deterministic | — | Push branch, create PR, post comment |

## Key Features Implemented

### Question Gates
- Taskify asks product/requirements questions if task is unclear
- Plan asks architecture/technical questions if decisions needed
- Posts questions on issue, sets `kody:waiting` label
- User replies with `@kody approve` + answers → pipeline resumes

### Complexity-Based Stage Skipping
- `--complexity low` skips plan, review, review-fix
- `--complexity medium` skips review-fix
- Auto-detected from taskify's risk_level output

### Multi-Runner Support
- `kody.config.json` supports per-stage runner assignment
- Claude Code runner: `claude --print --model <model>`
- OpenCode runner: `opencode run --model <model>`
- Configurable via `agent.runners` and `agent.stageRunners`

### Smart Init
- `kody-engine-lite init` spawns Claude Code (haiku) to analyze the project
- Auto-generates kody.config.json with correct quality commands
- Generates .kody/memory/architecture.md and conventions.md
- Post-LLM deterministic validation overrides with exact package.json script matches
- Creates 14 GitHub labels, checks secrets, validates auth

### GitHub Interaction
- `@kody` — full pipeline (auto-generates task-id)
- `@kody fix` — rerun from build with comment body as feedback
- `@kody approve` — resume paused pipeline with answers
- `@kody rerun` — auto-detects paused/failed stage
- Branch syncing: merges latest default branch before each run
- PR body: What/Scope/Changes/Review/Verify/Plan sections
- PR title: conventional commit prefix from task_type
- Lifecycle labels: planning → building → review → done/failed/waiting
- Type labels: kody:feature, kody:bugfix, kody:refactor, kody:docs, kody:chore
- Complexity labels: kody:low, kody:medium, kody:high

## Commands

```bash
# Development (from Kody-Engine-Lite repo)
pnpm typecheck          # TypeScript check
pnpm test               # Run all 126 tests
pnpm build              # Build npm package (tsup)
pnpm kody run ...       # Run pipeline in dev mode (tsx)

# Package CLI (installed globally)
kody-engine-lite init          # Setup target repo
kody-engine-lite init --force  # Regenerate all files
kody-engine-lite run --task "..." --cwd /path/to/project
kody-engine-lite fix --issue-number 42 --cwd /path/to/project
kody-engine-lite rerun --issue-number 42
kody-engine-lite status --task-id <id>
kody-engine-lite --version

# Publishing
npm publish --access public   # Publish to npm (bump version first)
```

## Testing

```bash
pnpm test                     # 126 tests, 16 files
pnpm test -- --coverage       # With coverage report
```

Test files cover:
- validators, definitions, config, context, memory, kody-utils (unit)
- agent-runner, state-machine, logger (unit with mocks)
- approve flow, fix command, PR title, PR description (unit)
- questions gate, paused state detection (unit)
- full pipeline with mock runner (integration)

**Testing target repo:** `/Users/aguy/projects/Kody-Engine-Tester/` (https://github.com/aharonyaircohen/Kody-Engine-Tester). Always use `--cwd` to avoid contaminating Kody's own repo.

## External References

- **Kody-Engine (original):** `/Users/aguy/projects/Kody-Engine/` — the predecessor using OpenCode + MiniMax
- **Brain server:** `/Users/aguy/projects/brain/brain-server/` — Phase 7/9 future Brain/Engine split
- **A-Guy (production target):** `/Users/aguy/projects/A-Guy/` — 881-file Next.js + Payload CMS project
- **Kody-Engine-Tester:** `/Users/aguy/projects/Kody-Engine-Tester/` — test target repo

## Session Summary (What Was Built)

This project was built from scratch in a single session, following a 9-phase lean plan:

1. **Phase 1:** Minimal CLI — single build stage, AgentRunner interface, Claude Code subprocess
2. **Phase 2:** Multi-stage pipeline — taskify→plan→build→review, context assembly, validators
3. **Phase 3:** Persistence — status.json, resume, 7 stages, verify+autofix loop, review+fix loop, config, logger
4. **Phase 4:** Superpowers — prompt methodology, memory system (.kody/memory/), auto-learn
5. **Phase 5:** LiteLLM — model routing config, per-stage aliases, backward compatible
6. **Phase 6:** GitHub — git ops, PR creation, labels, workflow, comments, lifecycle
7. **Phase 8:** Gap analysis — compared vs Kody-Engine, fixed: failure comments, variant detection, feedback injection
8. **Multi-runner:** Per-stage runner switching (Claude Code + OpenCode), complexity-based stage skipping
9. **Question gates:** Taskify asks product questions, plan asks architecture questions, @kody approve flow
10. **Smart init:** LLM-powered project analysis, deterministic validation, label creation
11. **Fix command:** @kody fix on PRs, branch detection, comment body as feedback
12. **PR quality:** Conventional commit title, rich PR body with What/Scope/Changes sections
13. **Branch syncing:** Merge latest default branch before every run

### Key Bugs Fixed During Development
- Taskify returns JSON wrapped in markdown fences — validator warns but doesn't fail
- Paused pipeline posted false "Pipeline failed" comment — fixed to detect pause and exit cleanly
- @kody approve started fresh pipeline instead of resuming — fixed workflow parse order
- PR title used raw issue markdown — fixed to use task.json title with conventional prefix
- @kody fix on PR used PR number not issue number — fixed with branch-based task lookup
- findLatestTask matched files not directories — fixed with withFileTypes filter
- Smart init picked `pnpm test` instead of `pnpm test:unit` — fixed with deterministic validation
- OpenCode runner used wrong command syntax — fixed to `opencode run --model <model>`

### Tools Used in This Session
- **Claude Code** (Opus 4.6, 1M context) — primary development agent
- **GitHub CLI (gh)** — issue/PR management, workflow triggers, label creation
- **pnpm** — package management
- **tsup** — TypeScript bundling
- **vitest** — testing
- **npm** — package publishing (@kody-ade/kody-engine-lite)
- **Claude Code CLI** — agent execution engine (spawned as subprocess by Kody)
- **OpenCode CLI** — alternative agent execution (MiniMax model support)

## What's NOT Done Yet (Future Work)

- **Phase 7:** Brain/Engine split (separate VPS service for reasoning stages)
- **Phase 9:** Brain server parity with existing brain-server
- Open source readiness: LICENSE file, CONTRIBUTING.md, CHANGELOG, clean up plans/
- PR review comment reading (changes_requested triggers pipeline but doesn't use review comments)
- Mock LLM server for testing without API calls
- Self-hosted runner support in workflow
