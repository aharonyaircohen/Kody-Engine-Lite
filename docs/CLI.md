# CLI Reference

Full command reference for `kody-engine-lite`. Run `kody-engine-lite --help` for a quick summary.

## Setup Commands

### `init`

Set up a repository for Kody. Analyzes your project and generates all required files.

```bash
kody-engine-lite init [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing files (workflow, config, memory, step files) |

**What it generates:**
- `.github/workflows/kody.yml` — GitHub Actions workflow
- `kody.config.json` — auto-detected quality commands, git settings, GitHub config
- `.kody/memory/` — architecture and conventions (via Claude Code)
- `.kody/steps/` — customized per-stage instruction files (via Claude Code)

Then commits and pushes everything.

### `bootstrap`

Regenerate project memory and step files. Useful after major refactors.

```bash
kody-engine-lite bootstrap [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing memory and step files |

Also available as `@kody bootstrap` on GitHub.

## Pipeline Commands

### `run`

Run the full Kody pipeline on an issue or ad-hoc task.

```bash
kody-engine-lite run --task-id <id> [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--task-id <id>` | Yes* | Task identifier (auto-generated in CI) |
| `--task "<desc>"` | No | Ad-hoc task description (skips issue lookup) |
| `--issue-number <n>` | No | GitHub issue number to work on |
| `--complexity <level>` | No | Override auto-detection: `low`, `medium`, or `high` |
| `--feedback "<text>"` | No | Additional context injected into the build prompt |
| `--cwd <path>` | No | Working directory (defaults to current) |
| `--local` | No | Run locally (auto-enabled outside CI) |
| `--dry-run` | No | Run without creating branches or PRs |

**Environment variables:** `TASK_ID`, `ISSUE_NUMBER`, `COMPLEXITY`, `FEEDBACK`, `DRY_RUN`

**Examples:**
```bash
# Run on a GitHub issue
kody-engine-lite run --issue-number 42 --local --cwd ./project

# Run an ad-hoc task
kody-engine-lite run --task "Add retry utility" --local
```

### `fix`

Re-run the pipeline from the build stage with optional feedback. Used after reviewing a PR that needs changes.

```bash
kody-engine-lite fix --task-id <id> [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--task-id <id>` | Yes* | Task identifier |
| `--issue-number <n>` | No | GitHub issue number |
| `--feedback "<text>"` | No | Feedback injected into the build prompt |
| `--cwd <path>` | No | Working directory |

Also available as `@kody fix` on GitHub — human PR review comments and Kody's own review are automatically read as context.

**Example:**
```bash
kody-engine-lite fix --issue-number 42 --feedback "Use middleware pattern"
```

### `fix-ci`

Fix failing CI checks. Fetches CI failure logs and re-runs from the build stage.

```bash
kody-engine-lite fix-ci [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--pr-number <n>` | No | PR number with failing CI |
| `--ci-run-id <id>` | No | Specific CI run ID to diagnose |
| `--issue-number <n>` | No | GitHub issue number |
| `--feedback "<text>"` | No | Additional context |
| `--cwd <path>` | No | Working directory |

**Environment variables:** `PR_NUMBER`, `CI_RUN_ID`, `ISSUE_NUMBER`, `FEEDBACK`

Also available as `@kody fix-ci` on GitHub — auto-triggered when CI fails on a Kody PR (with loop guard).

**Example:**
```bash
kody-engine-lite fix-ci --pr-number 42 --ci-run-id 12345
```

### `rerun`

Resume the pipeline from a specific stage. Keeps artifacts from previous stages.

```bash
kody-engine-lite rerun --task-id <id> --from <stage> [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--task-id <id>` | Yes* | Task identifier |
| `--from <stage>` | Yes | Stage to resume from: `taskify`, `plan`, `build`, `verify`, `review`, `review-fix`, `ship` |
| `--issue-number <n>` | No | GitHub issue number |
| `--cwd <path>` | No | Working directory |

**Environment variables:** `TASK_ID`, `FROM_STAGE`, `ISSUE_NUMBER`

**Example:**
```bash
kody-engine-lite rerun --issue-number 42 --from verify
```

### `review`

Run a standalone code review on a PR.

```bash
kody-engine-lite review [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--pr-number <n>` | No | PR number to review |
| `--issue-number <n>` | No | GitHub issue number (to find associated PR) |
| `--cwd <path>` | No | Working directory |
| `--local` | No | Run locally (auto-enabled outside CI) |

**Environment variables:** `PR_NUMBER`, `ISSUE_NUMBER`

### `status`

Print the current state of a pipeline run.

```bash
kody-engine-lite status --task-id <id> [--cwd <path>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--task-id <id>` | Yes | Task identifier |
| `--cwd <path>` | No | Working directory |

**Example:**
```bash
kody-engine-lite status --task-id 42-260327-102254
```

### `version`

Print the installed version.

```bash
kody-engine-lite version
kody-engine-lite --version
kody-engine-lite -v
```

## GitHub Comment Commands

These commands are triggered by commenting on a GitHub issue or PR:

| Command | Description |
|---------|-------------|
| `@kody` | Run the full pipeline on an issue |
| `@kody approve` | Resume after questions or risk gate pause |
| `@kody fix` | Re-run from build stage. Reads human PR review comments + Kody's review as context. Additional feedback in the comment body is also injected |
| `@kody fix-ci` | Fix failing CI. Auto-triggered when CI fails on a Kody PR (with loop guard) |
| `@kody rerun` | Resume from the failed or paused stage |
| `@kody rerun --from <stage>` | Resume from a specific stage |
| `@kody bootstrap` | Regenerate project memory and step files |

## Notes

- Outside CI (no `GITHUB_ACTIONS` env), `--local` is enabled by default. Use `--no-local` to override.
- Most flags have equivalent environment variables (used by the GitHub Actions workflow).
- `--task-id` is auto-generated in CI from the issue number and timestamp.
