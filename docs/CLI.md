# CLI Reference

`kody-engine-lite` is Kody's command-line interface. Run `kody-engine-lite --help` for a summary of all commands.

## Command Summary

| Command | What it does |
|---------|-------------|
| `run` | Run the full pipeline on an issue or ad-hoc task |
| `hotfix` | Fast-track pipeline — build → verify → ship, skips taskify, plan, review |
| `rerun` | Resume a pipeline from a specific stage |
| `fix` | Re-run from build with review feedback as context |
| `fix-ci` | Fix failing CI — fetches failure logs, re-runs from build |
| `status` | Print the current state of a pipeline run (read-only) |
| `review` | Run a standalone code review on a PR |
| `resolve` | Merge the default branch into a PR and AI-resolve conflicts |
| `decompose` | Split a complex issue into parallel sub-tasks, merge and verify |
| `compose` | Retry the merge/verify/review/ship phase after decompose |
| `taskify` | Split an issue into structured sub-issues with priority and scope |
| `bootstrap` | Analyze the codebase and generate memory, step files, and labels |
| `init` | Set up a repository with workflow and config files (no LLM needed) |
| `watch` | Run health monitoring plugins |
| `chat` | Run Kody as a chat service via GitHub Actions |
| `release` | Automate version bump, changelog, and release PR |
| `revert` | Revert a merged PR |
| `graph` | Inspect and search Kody's graph memory |
| `version` | Print the installed version |

---

## Pipeline Commands

### `run` — Run the full pipeline

```
kody-engine-lite run --issue-number <n> [options]
```

Runs the complete pipeline on a GitHub issue: taskify → plan → build → verify → review → review-fix → ship. Creates a branch, commits code, and opens a pull request.

**Flags:**

| Flag | What it does |
|------|-------------|
| `--issue-number <n>` | GitHub issue to work on |
| `--task-id <id>` | Resume a specific task by ID |
| `--task "<desc>"` | Ad-hoc task (skips issue lookup) |
| `--complexity low\|medium\|high` | Override auto-detected complexity |
| `--feedback "<text>"` | Inject context into the build prompt |
| `--dry-run` | Run without creating branches, commits, or PRs |
| `--auto-mode` | Skip question and risk gates (for CI/cron) |
| `--cwd <path>` | Working directory |
| `--local` | Run locally (auto-enabled outside CI) |

**Complexity levels** change how the pipeline runs:

- **low** — taskify → build → verify → ship. plan, review, and review-fix are skipped. Fast.
- **medium** (default) — full pipeline with review. review-fix runs only if there are critical or major findings.
- **high** — full pipeline. The plan stage posts questions on the issue and the pipeline pauses until you comment `@kody approve`. Riskier changes get human sign-off.
- **hotfix** (via `hotfix` command) — build → verify → ship. taskify, plan, review, and review-fix are always skipped. verify runs only typecheck and lint — no test suite. Use for simple, well-understood fixes.

**Examples:**

```bash
# Run on an issue
kody-engine-lite run --issue-number 42 --local

# Ad-hoc task, no issue needed
kody-engine-lite run --task "Add retry utility" --local

# Automated pipeline (CI, cron, webhooks) — no gates
kody-engine-lite run --issue-number 42 --auto-mode
```

---

### `hotfix` — Fast-track for simple fixes

```
kody-engine-lite hotfix --issue-number <n> [options]
```

Runs build → verify → ship only. No taskify, no plan, no review. Designed for things like fixing a typo, adding a missing export, or patching a config. verify runs typecheck and lint but skips the test suite.

**Flags:** `--issue-number`, `--cwd`, `--local`, `--dry-run`

---

### `rerun` — Resume from a specific stage

```
kody-engine-lite rerun --from <stage> [--issue-number <n>]
```

Resume a pipeline from a specific stage. Skips everything before `--from`. Resumes from `--from` onward. Useful after a stage fails or after you've manually resolved an issue.

```bash
kody-engine-lite rerun --issue-number 42 --from verify
```

Stages: `taskify`, `plan`, `build`, `verify`, `review`, `review-fix`, `ship`.

---

### `fix` — Fix from review feedback

```
kody-engine-lite fix --pr-number <n> [--feedback "<text>"]
```

Re-runs from the build stage. The engine reads your review comments and applies fixes automatically. Pushes directly to the existing PR — does not create a new one.

---

### `fix-ci` — Fix failing CI

```
kody-engine-lite fix-ci --pr-number <n>
```

Fetches the CI failure logs, diagnoses the problem, and re-runs from the build stage. Pushes a fix to the existing PR.

On PRs labeled with `kody:*`, the engine auto-posts `@kody fix-ci` when CI fails. It will not re-trigger itself within 24 hours (loop guard), and it does not trigger on bot commits.

---

### `status` — Print pipeline state

```
kody-engine-lite status --issue-number <n>
```

Reads the current pipeline state and prints it. Read-only — no stages execute.

---

## Standalone Commands

### `review` — Code review on a PR

```
kody-engine-lite review --pr-number <n> [--local]
```

Runs a standalone AI code review on a PR. Posts a GitHub PR review (approve or request-changes) if the submission succeeds, or falls back to a plain comment. The review uses `git diff origin/<base>...HEAD` to identify changed files — findings reference the actual PR diff.

---

### `resolve` — Merge-conflict resolution

```
kody-engine-lite resolve --pr-number <n>
```

Merges the default branch into the PR branch, uses AI to resolve any conflicts, and pushes the result. Good for keeping PRs up-to-date without manual rebasing.

---

### `taskify` — Split into sub-issues

```
kody-engine-lite taskify --file docs/prd.md --ticket-id PROJECT-123
```

Parses a PRD or markdown file and creates structured GitHub sub-issues. Each sub-issue gets a priority label (`priority:high`, `priority:medium`, or `priority:low`) and body sections for context, test strategy, and acceptance criteria. Sub-issues are ordered respecting `depends on` annotations.

When run on a GitHub issue, taskify also reads project memory (`.kody/memory/`) and the repo file tree to understand existing patterns, and enriches the task with the issue's labels and discussion comments.

---

## Complex Commands

### `decompose` — Parallel sub-task split

```
kody-engine-lite decompose --issue-number <n> [--no-compose] [--local]
```

For complex multi-area issues. Scores task complexity 1-10. If the score is below 6, it falls back to the normal pipeline automatically — no harm, no waste. If the score is high enough, it splits the task into independent sub-tasks and builds them in parallel.

**How it works:**

1. Analyze — taskify + plan to understand the full scope
2. Decompose — AI groups plan steps into independent clusters
3. Parallel build — each sub-task gets an isolated git worktree and runs the build in parallel (up to 3 concurrent)
4. Compose — merges all branches, runs verify + review + ship as one PR

Each worktree is constrained to its own files only — worktrees cannot clobber each other's changes.

**If a sub-task fails:** all worktrees are cleaned up and the pipeline falls back to the normal single-branch pipeline.

**`--no-compose`:** run the parallel builds only, stop before merge. Useful for inspecting results before committing to the full flow.

```bash
# Full decompose
kody-engine-lite decompose --issue-number 42 --local

# Build only, inspect before merging
kody-engine-lite decompose --issue-number 42 --no-compose --local
```

Configuration in `kody.config.json`:

```json
{
  "decompose": {
    "enabled": true,
    "maxParallelSubTasks": 3,
    "minComplexityScore": 6
  }
}
```

---

### `compose` — Retry compose after decompose

```
kody-engine-lite compose --task-id <task-id>
```

After `--no-compose`, run compose to complete the merge/verify/review/ship phase. Also use this to retry after a verify or review failure — it skips the merge if already done and retries from the right stage.

---

## Setup Commands

### `init` — Set up the repository

```
kody-engine-lite init [--force]
```

Generates the workflow and config files deterministically. No LLM is called. Use `--force` to overwrite existing files.

Creates:
- `.github/workflows/kody.yml`
- `.github/workflows/kody-watch.yml`
- `.claude/skills/kody/SKILL.md` — Kody pipeline skill (issue-writing, triggering, monitoring, verifying)
- `kody.config.json`

Run `bootstrap` next to generate repo-aware step files.

---

### `bootstrap` — Generate project memory and step files

```
kody-engine-lite bootstrap [--force] [--model=<provider/model>]
```

Analyzes your codebase with an LLM and generates everything Kody needs to work repo-aware:

- `.kody/memory/architecture.md` — framework, language, database, key directories
- `.kody/memory/conventions.md` — naming patterns, error handling, testing conventions
- `.kody/steps/taskify.md`, `plan.md`, `build.md`, `autofix.md`, `review.md`, `review-fix.md`
- `.kody/tools.yml` — declared tools with skill content injected into prompts
- `.kody/qa-guide.md` — authentication steps and navigation maps for projects with routes

Also creates 14 GitHub labels: `kody:planning`, `kody:building`, `kody:verifying`, `kody:review`, `kody:done`, `kody:failed`, `kody:waiting`, `kody:low`, `kody:medium`, `kody:high`, `kody:feature`, `kody:bugfix`, `kody:refactor`, `kody:docs`, `kody:chore`.

`--model` accepts a single `provider/model` spec (e.g. `claude/claude-sonnet-4-6`, `minimax/MiniMax-M2.7-highspeed`) and overrides whatever the bootstrap stage would resolve from `kody.config.json` for this run only. When the provider isn't `claude`/`anthropic`, the engine starts a LiteLLM proxy to route requests.

Use `--force` to regenerate from scratch (instead of extending existing files).

---

## Monitor

### `watch` — Health monitoring

```
kody-engine-lite watch [--dry-run] [--agent <name>]
```

Runs three plugins on a schedule:

- **pipeline-health** (every cycle, ~30 min) — scans for stalled, failed, or stuck runs, posts findings to the activity log issue
- **security-scan** (daily) — checks for hardcoded secrets, dependency vulnerabilities, committed `.env` files, unsafe code patterns. Critical findings create GitHub issues.
- **config-health** (daily) — validates `kody.config.json`, checks for required secrets and labels

`--dry-run` runs all plugins but skips posting comments and creating issues.

`--agent <name>` runs a single plugin only (e.g. `pipeline-health`, `security-scan`, `config-health`). Useful for manual triggering via workflow dispatch without waiting for the next scheduled tick.

State (cycle counter, dedup timestamps) is persisted as an HTML comment on the activity log issue — no PAT needed, works with the default `github.token`.

---

## Chat

### `chat` — Run Kody as a chat service

```
kody-engine-lite chat --session <sessionId> [--model <model>] [--cwd <dir>]
```

Runs Kody as a GitHub Actions chat service. Sessions are stored as JSONL files, enabling conversation history across workflow runs.

**Flags:**

| Flag | Description |
|------|-------------|
| `--session` | Session ID (required). Maps 1:1 to a task ID. |
| `--model` | Model to use (default: from `kody.config.json`) |
| `--cwd` | Working directory (default: current directory) |

Sessions are triggered by calling `workflow_dispatch` on the `chat.yml` workflow with the session ID as input. The `chat.yml` workflow is installed automatically by `kody-engine-lite init`. For full details including session file format, event types, and GitHub Actions integration, see [Chat Sessions](CHAT-SESSIONS.md).

---

## Release Commands

### `release` — Version bump and release PR

```
kody-engine-lite release [--issue-number <n>] [--bump major|minor|patch] [--dry-run]
```

Parses conventional commits since the last release, bumps the version, generates a changelog grouped by type, creates a PR on `release/v<version>`, and optionally publishes to npm. Use `--dry-run` to preview without creating anything.

`--finalize` merges the PR, tags, and publishes. `--no-publish` skips the npm publish step.

---

### `revert` — Revert a merged PR

```
kody-engine-lite revert [--target <#N>] [--dry-run]
```

Runs `git revert` on a merged PR and opens a PR to restore the changes. If `--target` is omitted, it auto-resolves the PR from the branch name (`kody/issue-<N>`). PR title format: `revert: <original> (#N)`.

---

## Read-Only Commands

### `graph` — Inspect graph memory

```
kody graph status <path>
kody graph query <path> [query]
kody graph search <path> <query>
kody graph show <path> <nodeId>
kody graph migrate <path>
kody graph clear <path> --confirm
```

No side effects for `status`, `query`, `show`, and `search`. `migrate` converts legacy `.md` memory files to the graph store. `clear` resets all graph data.

---

### `version` — Print version

```
kody-engine-lite version
kody-engine-lite --version
```

Prints the installed version and exits.

---

## Notes

- Outside CI (no `GITHUB_ACTIONS` env), `--local` is on by default. Pass `--no-local` to override.
- `--task-id` is auto-generated in CI: `<issue-number>-<YYYYMMDD-HHMMSS>`
- All commands that create PRs include `Closes #<N>` in the PR body, which auto-closes the linked issue on merge.
- `status` and `version` have no side effects. `graph` (except `migrate` and `clear`) has no side effects.
