# CLI Reference

Full command reference for `kody-engine-lite`. Run `kody-engine-lite --help` for a quick summary.

## Setup Commands

### `init`

Set up a repository for Kody. Generates the workflow and config files deterministically (no LLM needed).

```bash
kody-engine-lite init [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing workflow and config files |

**What it generates:**
- `.github/workflows/kody.yml` — GitHub Actions workflow
- `kody.config.json` — auto-detected quality commands, git settings, GitHub config

Then commits and pushes. Run `bootstrap` next to generate repo-aware step files.

### `bootstrap`

Generate project memory, customized step files, and GitHub labels by analyzing your codebase with an LLM. Required after `init` for a complete setup. Also useful after major refactors.

```bash
kody-engine-lite bootstrap [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing memory and step files |

Also available as `@kody bootstrap` on GitHub.

## Pipeline Commands

**When to use which:** Use **run** to start a fresh pipeline on a new issue or task. Use **fix** when a PR needs changes based on review feedback. Use **fix-ci** when CI is failing. Use **rerun** to retry from a specific stage after failure. Use **review** for standalone PR reviews.

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

Re-run from build with review feedback as context. Automatically reads three layers: Kody's own review findings, human PR review comments (inline + top-level), and any text you include in the comment or `--feedback` flag.

```bash
kody-engine-lite fix --task-id <id> [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--task-id <id>` | Yes* | Task identifier |
| `--issue-number <n>` | No | GitHub issue number |
| `--feedback "<text>"` | No | Additional feedback injected into the build prompt |
| `--cwd <path>` | No | Working directory |

Also available as `@kody fix` on GitHub.

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
| `--task-id <id>` | No* | Task identifier (auto-resolved from issue comments if omitted) |
| `--from <stage>` | Yes | Stage to resume from: `taskify`, `plan`, `build`, `verify`, `review`, `review-fix`, `ship` |
| `--issue-number <n>` | No | GitHub issue number |
| `--cwd <path>` | No | Working directory |

**Environment variables:** `TASK_ID`, `FROM_STAGE`, `ISSUE_NUMBER`

**Note:** `rerun` bypasses the "already-completed" state check, so you can re-run stages even after the pipeline has finished. When `--task-id` is omitted, the engine auto-resolves the latest task for the issue by scanning `.kody/tasks/` or issue comments.

**Example:**
```bash
kody-engine-lite rerun --issue-number 42 --from verify
```

### `resolve`

Merge the default branch into a PR branch and AI-resolve any merge conflicts. Runs quality gates after resolution.

```bash
kody-engine-lite resolve --pr-number <n> [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--pr-number <n>` | Yes | PR number to resolve conflicts for |
| `--cwd <path>` | No | Working directory |
| `--local` | No | Run locally (auto-enabled outside CI) |

**Environment variables:** `PR_NUMBER`

Also available as `@kody resolve` on GitHub.

**Example:**
```bash
kody-engine-lite resolve --pr-number 42
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
| `--task-id <id>` | No* | Task identifier (auto-resolved from issue if omitted) |
| `--issue-number <n>` | No | GitHub issue number (used for auto-resolution) |
| `--cwd <path>` | No | Working directory |

When `--task-id` is omitted, the engine auto-resolves the latest task for the issue.

**Example:**
```bash
kody-engine-lite status --task-id 42-260327-102254
kody-engine-lite status --issue-number 42
```

### `ci-parse`

Parse a GitHub comment into structured pipeline inputs. Used internally by the workflow template to replace the shell parser.

```bash
kody-engine-lite ci-parse
```

Reads from environment variables (`COMMENT_BODY`, `ISSUE_NUMBER`, `ISSUE_IS_PR`, `TRIGGER_TYPE`) and writes outputs to `$GITHUB_OUTPUT`.

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
| `@kody review` | Run a standalone code review on a PR — posts structured findings and submits a GitHub review (approve or request-changes). Falls back to a plain PR comment if the review submission fails (e.g., self-review not allowed) |
| `@kody approve` | Resume after questions or risk gate pause |
| `@kody fix` | Re-run from build stage. Reads human PR review comments + Kody's review as context. Additional feedback in the comment body is also injected |
| `@kody fix-ci` | Fix failing CI. Auto-triggered when CI fails on a Kody PR (with loop guard) |
| `@kody resolve` | Merge default branch into PR, AI-resolve conflicts, verify, and push |
| `@kody rerun` | Resume from the failed or paused stage |
| `@kody rerun --from <stage>` | Resume from a specific stage |
| `@kody bootstrap` | Regenerate project memory and step files |

## Notes

- Outside CI (no `GITHUB_ACTIONS` env), `--local` is enabled by default. Use `--no-local` to override.
- Most flags have equivalent environment variables (used by the GitHub Actions workflow).
- `--task-id` is auto-generated in CI from the issue number and timestamp.
