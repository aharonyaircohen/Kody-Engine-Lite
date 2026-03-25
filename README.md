# Kody Engine Lite

Autonomous SDLC pipeline — runs a 7-stage pipeline (taskify → plan → build → verify → review → review-fix → ship) on your codebase using Claude Code as the execution engine.

## How it works

```
@kody full <task-id>  (comment on a GitHub issue)
     ↓
GitHub Actions workflow triggers
     ↓
Kody Engine Lite (npm package)
     ↓
7-stage pipeline:
  1. taskify  — classify the task (haiku)
  2. plan     — create implementation plan (sonnet)
  3. build    — implement code changes (opus)
  4. verify   — run typecheck + tests + lint
  5. review   — code review (sonnet)
  6. review-fix — fix review issues (opus)
  7. ship     — push branch + create PR
     ↓
PR created on your repo
```

## Quick Start

### 1. Install

```bash
npm install -g @kody-ade/kody-engine-lite
```

### 2. Init (run in your project root)

```bash
cd your-project
kody-engine-lite init
```

This will:
- Copy `.github/workflows/kody.yml` to your repo
- Create `kody.config.json` (edit this)
- Create `.kody/memory/architecture.md` (auto-detected)
- Create `.kody/memory/conventions.md` (seed)
- Add `.tasks/` to `.gitignore`
- Run health checks (prerequisites, GitHub auth, secrets)

### 3. Configure

Edit `kody.config.json`:

```json
{
  "quality": {
    "typecheck": "pnpm tsc --noEmit",
    "lint": "pnpm lint",
    "lintFix": "pnpm lint:fix",
    "format": "",
    "formatFix": "",
    "testUnit": "pnpm test"
  },
  "git": {
    "defaultBranch": "main"
  },
  "github": {
    "owner": "your-org",
    "repo": "your-repo"
  },
  "paths": {
    "taskDir": ".tasks"
  },
  "agent": {
    "runner": "claude-code",
    "modelMap": {
      "cheap": "haiku",
      "mid": "sonnet",
      "strong": "opus"
    }
  }
}
```

### 4. GitHub Setup

#### Required Secret

Add `ANTHROPIC_API_KEY` to your repo secrets:

```bash
gh secret set ANTHROPIC_API_KEY --repo owner/repo
```

#### Required Permissions

Go to **Settings → Actions → General → Workflow permissions**:

1. Select **"Read and write permissions"**
2. Check **"Allow GitHub Actions to create and approve pull requests"**
3. Save

Without this, the ship stage cannot create PRs.

### 5. Push and Use

```bash
git add .github/workflows/kody.yml kody.config.json .kody/
git commit -m "chore: add kody engine"
git push
```

Then comment on any issue:

```
@kody full my-task-id
```

## CLI Usage

### Run locally

```bash
# Run against current directory
kody-engine-lite run --task-id my-task --task "Add a sum function to src/math.ts with tests"

# Run against a different project
kody-engine-lite run --task-id my-task --task "Add feature X" --cwd /path/to/project

# Run from a GitHub issue (fetches issue body as task)
kody-engine-lite run --task-id my-task --issue-number 1 --cwd /path/to/project

# Dry run (no agent calls)
kody-engine-lite run --task-id my-task --task "Test" --dry-run

# Resume from a failed stage
kody-engine-lite rerun --task-id my-task --from review

# Check pipeline status
kody-engine-lite status --task-id my-task
```

### Init a new project

```bash
cd your-project
kody-engine-lite init          # setup workflow, config, memory
kody-engine-lite init --force  # overwrite existing workflow
```

### GitHub Comment Triggers

Comment on any issue:

```
@kody full <task-id>                      # Run full pipeline
@kody rerun <task-id> --from <stage>      # Resume from stage
@kody status <task-id>                    # Check status
```

## Pipeline Stages

| Stage | Model | What it does |
|-------|-------|-------------|
| taskify | haiku | Classifies task from issue body → `task.json` |
| plan | opus | Deep reasoning: creates TDD implementation plan → `plan.md` |
| build | sonnet | Implements code changes (Claude Code tools handle execution) |
| verify | — | Runs typecheck + tests + lint (from `kody.config.json`) |
| review | opus | Thorough code review → `review.md` (PASS/FAIL + findings) |
| review-fix | sonnet | Applies known fixes from review findings |
| ship | — | Pushes branch + creates PR + comments on issue |

### Automatic Loops

- **Verify + autofix**: If verify fails, runs lint-fix + format-fix + autofix agent, retries up to 2 times
- **Review + fix**: If review verdict is FAIL, runs review-fix agent then re-reviews

## Memory System

Kody maintains project memory in `.kody/memory/`:

- **`architecture.md`** — auto-detected on `init` (framework, language, testing, directory structure)
- **`conventions.md`** — auto-learned after each successful pipeline run

Memory is prepended to every agent prompt, giving Claude Code project context.

## Configuration Reference

### `kody.config.json`

| Field | Description | Default |
|-------|-------------|---------|
| `quality.typecheck` | Typecheck command | `pnpm -s tsc --noEmit` |
| `quality.lint` | Lint command | `pnpm -s lint` |
| `quality.lintFix` | Lint fix command | `pnpm lint:fix` |
| `quality.format` | Format check command | `""` |
| `quality.formatFix` | Format fix command | `""` |
| `quality.testUnit` | Test command | `pnpm -s test` |
| `git.defaultBranch` | Default branch | `dev` |
| `github.owner` | GitHub org/user | `""` |
| `github.repo` | GitHub repo name | `""` |
| `paths.taskDir` | Task artifacts directory | `.tasks` |
| `agent.modelMap.cheap` | Model for taskify | `haiku` |
| `agent.modelMap.mid` | Model for build/review-fix/autofix | `sonnet` |
| `agent.modelMap.strong` | Model for plan/review (deep reasoning) | `opus` |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key (set as repo secret) |
| `GH_TOKEN` | Auto | GitHub token (provided by Actions) |
| `GH_PAT` | No | Personal access token (preferred over GH_TOKEN) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |
| `LITELLM_BASE_URL` | No | LiteLLM proxy URL for model routing |

## LiteLLM (Optional)

For multi-provider model routing with fallback:

```bash
pip install litellm[proxy]
litellm --config litellm-config.yaml --port 4000
```

Then set in `kody.config.json`:

```json
{
  "agent": {
    "litellmUrl": "http://localhost:4000",
    "modelMap": { "cheap": "cheap", "mid": "mid", "strong": "strong" }
  }
}
```

## Task Artifacts

Each pipeline run creates artifacts in `.tasks/<task-id>/`:

| File | Created by | Content |
|------|-----------|---------|
| `task.md` | entry / issue fetch | Task description |
| `task.json` | taskify stage | Structured classification |
| `plan.md` | plan stage | Implementation steps |
| `verify.md` | verify stage | Quality gate results |
| `review.md` | review stage | Code review + verdict |
| `ship.md` | ship stage | PR URL |
| `status.json` | state machine | Pipeline state (per-stage) |

## Architecture

```
@kody-ade/kody-engine-lite (npm package)
├── dist/bin/cli.js      — CLI entry point
├── prompts/             — Stage prompt templates
│   ├── taskify.md
│   ├── plan.md
│   ├── build.md
│   ├── review.md
│   ├── review-fix.md
│   └── autofix.md
└── templates/
    └── kody.yml         — GitHub Actions workflow template
```

Source files (in this repo):

```
src/
├── entry.ts          — CLI argument parsing, pipeline dispatch
├── types.ts          — TypeScript interfaces
├── definitions.ts    — 7-stage pipeline configuration
├── state-machine.ts  — Pipeline orchestration loop
├── agent-runner.ts   — Claude Code subprocess wrapper
├── context.ts        — Prompt assembly + task context injection
├── memory.ts         — Project memory reader
├── config.ts         — Config loading (kody.config.json)
├── logger.ts         — Structured logging
├── preflight.ts      — Startup checks
├── validators.ts     — Output validation
├── verify-runner.ts  — Quality gate execution
├── kody-utils.ts     — Task directory utilities
├── git-utils.ts      — Git operations
├── github-api.ts     — GitHub API via gh CLI
└── bin/cli.ts        — Package CLI (init, run, version)
```

## Development

```bash
# Install deps
pnpm install

# Type check
pnpm typecheck

# Run locally (dev mode)
pnpm kody run --task-id test --task "Add feature" --cwd /path/to/project

# Build package
pnpm build

# Publish
npm publish --access public
```
