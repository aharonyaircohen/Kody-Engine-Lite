# Kody Engine Lite

Autonomous SDLC pipeline. Comment `@kody` on a GitHub issue → Kody classifies, plans, builds, tests, reviews, fixes, and ships a PR. Zero human intervention required.

## How it works

```
@kody  (comment on a GitHub issue)
  ↓
GitHub Actions workflow
  ↓
7-stage pipeline:
  1. taskify  — classify task, detect complexity, ask questions if unclear
  2. plan     — TDD implementation plan (opus — deep reasoning)
  3. build    — implement code changes (sonnet — tool use via Claude Code)
  4. verify   — typecheck + tests + lint (auto-fix on failure)
  5. review   — code review with severity levels (opus)
  6. review-fix — fix Critical/Major findings (sonnet)
  7. ship     — push branch + create PR with Closes #N
  ↓
PR created with What/Scope/Changes description
```

## Quick Start

```bash
# Install
npm install -g @kody-ade/kody-engine-lite

# Init (in your project root) — auto-detects everything
cd your-project
kody-engine-lite init

# Push and use
git add .github/workflows/kody.yml kody.config.json .kody/
git commit -m "chore: add kody engine"
git push

# Comment on any issue
@kody
```

### What `init` does

Spawns Claude Code to analyze your project and auto-generates:
- `.github/workflows/kody.yml` — full CI/CD workflow
- `kody.config.json` — quality commands auto-detected from `package.json`
- `.kody/memory/architecture.md` — project-specific tech stack and structure
- `.kody/memory/conventions.md` — coding patterns, references to existing docs
- 14 GitHub labels — lifecycle, complexity, and type labels
- Health checks — CLI tools, GitHub auth, secrets, config validation

### GitHub Setup

**Required secret:**
```bash
gh secret set ANTHROPIC_API_KEY --repo owner/repo
```

**Required permission:**
Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"

## Commands

### GitHub Comments

```
@kody                         Run full pipeline (auto-generates task-id)
@kody approve                 Answer questions and resume paused pipeline
@kody fix                     Re-build from build stage (on issues or PRs)
@kody fix                     Comment body = feedback for the fix
  fix the auth middleware
  to return 401 not 500
@kody rerun                   Resume from failed/paused stage
@kody rerun --from <stage>    Resume from specific stage
```

### CLI

```bash
kody-engine-lite run --task "Add feature X" --cwd /path/to/project
kody-engine-lite run --issue-number 42 --cwd /path/to/project
kody-engine-lite fix --issue-number 42 --feedback "Use middleware pattern"
kody-engine-lite rerun --issue-number 42
kody-engine-lite status --task-id <id>
kody-engine-lite init [--force]
```

## Pipeline Stages

| Stage | Model | What it does |
|-------|-------|-------------|
| taskify | haiku | Classify task → `task.json` (type, scope, risk, questions) |
| plan | opus | Create TDD plan → `plan.md` (deep reasoning) |
| build | sonnet | Implement code using Claude Code tools (Read/Write/Edit/Bash) |
| verify | — | Run typecheck + tests + lint from `kody.config.json` |
| review | opus | Code review → `review.md` (PASS/FAIL + Critical/Major/Minor) |
| review-fix | sonnet | Fix Critical and Major findings |
| ship | — | Push branch, create PR, comment on issue |

## Key Features

### Question Gates

Kody asks before building if something is unclear:

- **Taskify** asks product/requirements questions ("Should search be case-sensitive?")
- **Plan** asks architecture/technical questions ("Recommend middleware pattern — approve?")
- Pipeline pauses with `kody:waiting` label
- Resume with `@kody approve` + your answers in the comment body

### Complexity-Based Stage Skipping

Auto-detected from taskify's risk assessment, or override with `--complexity`:

| Complexity | Runs | Skips |
|-----------|------|-------|
| low | taskify → build → verify → ship | plan, review, review-fix |
| medium | taskify → plan → build → verify → review → ship | review-fix |
| high | all 7 stages | nothing |

### Branch Syncing

Every run merges latest from the default branch into the feature branch before building.

### Verify + Autofix Loop

If verify fails: runs lint-fix → format-fix → autofix agent → retries (up to 2 attempts).

### Review + Fix Loop

If review verdict is FAIL: runs review-fix agent → re-reviews.

### Rich PR Description

```markdown
## What
Add authentication middleware to 8 unprotected API routes

## Scope
- `src/middleware/auth.ts`
- `src/app/api/cron/route.ts`

**Type:** bugfix | **Risk:** high

## Changes
Added auth middleware to all cron routes and copilotkit endpoint.

**Review:** ✅ PASS
**Verify:** ✅ typecheck + tests + lint passed

<details><summary>📋 Implementation plan</summary>
...
</details>

Closes #42
```

### Labels

`init` creates 14 labels:
- **Lifecycle:** `kody:planning`, `kody:building`, `kody:review`, `kody:done`, `kody:failed`, `kody:waiting`
- **Complexity:** `kody:low`, `kody:medium`, `kody:high`
- **Type:** `kody:feature`, `kody:bugfix`, `kody:refactor`, `kody:docs`, `kody:chore`

### Memory System

`.kody/memory/` files are prepended to every agent prompt:
- `architecture.md` — auto-generated by `init`
- `conventions.md` — auto-learned after each successful run

## Using Non-Anthropic Models (LiteLLM)

Claude Code can use **any model** through a LiteLLM proxy. Tested with MiniMax (full tool use: Write, Read, Edit, Bash, Grep).

```bash
# Start LiteLLM proxy
docker run -d -p 4000:4000 \
  -e MINIMAX_API_KEY=your-key \
  -v config.yaml:/app/config.yaml \
  ghcr.io/berriai/litellm:main-latest --config /app/config.yaml
```

```yaml
# config.yaml
model_list:
  - model_name: minimax
    litellm_params:
      model: minimax/MiniMax-M2.7-highspeed
      api_key: os.environ/MINIMAX_API_KEY
```

```json
// kody.config.json
{
  "agent": {
    "litellmUrl": "http://localhost:4000",
    "modelMap": { "cheap": "minimax", "mid": "minimax", "strong": "minimax" }
  }
}
```

LiteLLM translates Anthropic's tool-use protocol to the target provider's format. No code changes needed.

## Configuration

### `kody.config.json`

| Field | Description | Default |
|-------|-------------|---------|
| `quality.typecheck` | Typecheck command | `pnpm -s tsc --noEmit` |
| `quality.lint` | Lint command | `""` |
| `quality.lintFix` | Auto-fix lint | `""` |
| `quality.testUnit` | Unit test command | `pnpm -s test` |
| `git.defaultBranch` | Default branch | `dev` |
| `github.owner` | GitHub org/user | auto-detected |
| `github.repo` | Repository name | auto-detected |
| `agent.modelMap.cheap` | Taskify model | `haiku` |
| `agent.modelMap.mid` | Build/fix model | `sonnet` |
| `agent.modelMap.strong` | Plan/review model | `opus` |
| `agent.litellmUrl` | LiteLLM proxy URL | — |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key (repo secret) |
| `GH_TOKEN` | Auto | GitHub token (provided by Actions) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` |

## Architecture

```
src/
├── entry.ts          — CLI: run/rerun/fix/status, arg parsing, CI mode
├── state-machine.ts  — Pipeline loop, stage dispatch, question gates, complexity
├── agent-runner.ts   — Claude Code subprocess wrapper (thin — spawn, pipe, timeout)
├── context.ts        — Prompt assembly + memory + task context injection
├── definitions.ts    — 7-stage pipeline config
├── types.ts          — TypeScript interfaces
├── config.ts         — kody.config.json loader + constants
├── git-utils.ts      — Branch, commit, push, sync, diff
├── github-api.ts     — Issues, labels, PRs, comments via gh CLI
├── verify-runner.ts  — Quality gate execution
├── validators.ts     — Output validation (task.json, plan.md, review.md)
├── memory.ts         — .kody/memory/ reader
├── logger.ts         — Structured logging with CI groups
├── preflight.ts      — Startup health checks
├── kody-utils.ts     — Task directory utilities
└── bin/cli.ts        — Package CLI: init (LLM-powered), run, version
```

## Development

```bash
pnpm install          # Install deps
pnpm typecheck        # Type check
pnpm test             # 125 tests (16 files)
pnpm build            # Build npm package
pnpm kody run ...     # Dev mode (tsx)
npm publish --access public  # Publish
```

## Security

Only GitHub collaborators (COLLABORATOR, MEMBER, OWNER) can trigger `@kody`. External contributors cannot.

## License

MIT
