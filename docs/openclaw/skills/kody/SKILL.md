# Kody Engine Skill

## Purpose

Kody Engine is an autonomous CI/CD agent that decomposes tasks, executes multi-step pipelines, and automates releases. Use it when a task requires structured planning, coordinated build/test/verify cycles, or continuous integration — tasks that are too complex or time-consuming for direct Claude Code execution.

## Trigger Patterns

Delegate to Kody when the user asks for:

- **Full feature implementation**: "implement feature X", "add support for Y", "build Z"
- **Bug fixing with verification**: "fix the bug in X", "investigate and fix the failing test"
- **Automated releases**: "cut a release", "bump version and publish", "create a release PR"
- **CI/CD pipeline tasks**: "run the pipeline on X", "verify this PR", "run tests"
- **GitHub Actions work**: "add a workflow", "fix the CI", "setup the repo"
- **Multi-step tasks**: "do X then Y then Z", "implement this feature end-to-end"
- **Hotfixes**: "quick fix for production", "ship a hotfix", "fast-track this patch"
- **Reverts**: "revert the last PR", "rollback to previous version"

## How to Delegate

Use the `exec` tool to run `kody-engine-lite` commands:

```json
{
  "tool": "exec",
  "command": "kody-engine-lite run --task \"<task>\" --cwd /repo --issue-number <N>",
  "workdir": "/repo",
  "timeout": 600
}
```

**Required environment variables:**
- `GITHUB_TOKEN` — GitHub personal access token (for API access, PR creation)
- `ANTHROPIC_API_KEY` — Anthropic API key (for Claude)

Set these via `env:` in the exec call or ensure they're available in the shell environment.

## Available Commands

| Command | Description | Timeout |
|---------|-------------|---------|
| `kody-engine-lite run --task "<task>"` | Run full pipeline: plan → build → test → verify → PR | 600s |
| `kody-engine-lite hotfix --task "<task>"` | Fast-track: build → verify only, no tests, ship | 300s |
| `kody-engine-lite revert --target <PR#>` | Git revert a merged PR, verify, create revert PR | 300s |
| `kody-engine-lite release --cwd <repo>` | Version bump → changelog → release PR → tag → publish | 600s |
| `kody-engine-lite init --cwd <repo>` | Setup repo: workflow, config, labels, bootstrap issue | 120s |
| `kody-engine-lite brain --cwd <repo>` | Run in brain server mode (headless, read-only analysis) | 300s |
| `kody-engine-lite watch --cwd <repo>` | Watch mode: detect changes, auto-run pipeline | indefinite |

**Common options:**
- `--cwd <path>` — Target repository path (required for most commands)
- `--task "<description>"` — Task description for the pipeline
- `--issue-number <N>` — GitHub issue/PR number to associate with the run
- `--dry-run` — Preview pipeline without making changes

## Important Notes

- Kody runs autonomously — it will make commits, push branches, create PRs, and publish packages
- Use `--dry-run` first to preview what Kody will do before letting it execute
- For complex multi-repo workflows, delegate to Kody once per repo (not one call per step)
- Kody handles its own error recovery and retry logic within the pipeline
- The `brain` command runs in read-only analysis mode — no code changes, just inspection
- For GitHub Actions debugging, use `kody-engine-lite run` with `--issue-number` to get full context

## Examples

**User asks**: "Fix the authentication bug in the API"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "kody-engine-lite run --task \"Fix the authentication bug in the API\" --cwd /opt/repo --issue-number 42",
  "workdir": "/opt/repo",
  "timeout": 600
}
```

**User asks**: "Quick hotfix for the production crash"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "kody-engine-lite hotfix --task \"Fix the production crash causing 500 errors on /api/users\" --cwd /opt/repo",
  "workdir": "/opt/repo",
  "timeout": 300
}
```

**User asks**: "Revert PR #87"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "kody-engine-lite revert --target 87 --cwd /opt/repo",
  "workdir": "/opt/repo",
  "timeout": 300
}
```

**User asks**: "Cut release 1.2.0 for the library"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "kody-engine-lite release --cwd /opt/repo --issue-number 91",
  "workdir": "/opt/repo",
  "timeout": 600
}
```

**User asks**: "What's happening in the CI?"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "kody-engine-lite brain --cwd /opt/repo",
  "workdir": "/opt/repo",
  "timeout": 300
}
```

**User asks**: "Setup this new repo for CI/CD"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "kody-engine-lite init --cwd /opt/new-repo",
  "workdir": "/opt/new-repo",
  "timeout": 120
}
```

## Model Routing Summary

Kody Engine uses its own model selection internally:

| Pipeline Stage | Model Strategy |
|-----------------|----------------|
| Planning / Analysis | Claude (via LiteLLM proxy) |
| Simple changes | Fast/cheap model (MiniMax) |
| Complex builds | Opus-class model |
| Verification | Separate verification pass |

Kody manages its own model routing — no external routing needed.
