# Kody Engine Lite

[![npm](https://img.shields.io/npm/v/@kody-ade/kody-engine-lite)](https://www.npmjs.com/package/@kody-ade/kody-engine-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Comment `@kody` on a GitHub issue. Get back a tested, reviewed PR. Free and open source.**

Kody wraps Claude Code with a 7-stage autonomous pipeline — classify, plan, build, verify, review, fix, ship — with quality gates between every stage. If verify catches a bug, it gets fixed before review ever sees it. No blind retries, no context drift, no babysitting.

- **Repo-aware prompts** — `bootstrap` analyzes your codebase and generates customized instructions for every stage, not generic "write clean code" prompts
- **Quality gates** — runs your repo's typecheck, tests, and lint between stages + AI code review in a fresh session
- **AI failure diagnosis** — classifies errors as fixable/infrastructure/pre-existing before retrying
- **Self-improving** — learns conventions, remembers architectural decisions, discovers existing patterns
- **Runs anywhere** — locally from your terminal or via GitHub Actions
- **Anthropic-compatible models** — Anthropic natively, or other providers (MiniMax, Gemini, etc.) via LiteLLM proxy

[Why Kody? →](docs/ABOUT.md) · [Full comparison →](docs/COMPARISON.md)

```
@kody on issue
    │
    ▼
① TASKIFY ─── classify, scope, detect complexity, ask questions
    │
    ▼
② PLAN ────── TDD implementation plan (deep reasoning)
    │          🛑 HIGH risk? Pause for human approval
    ▼
③ BUILD ───── implement via Claude Code tools
    │
    ▼
④ VERIFY ──── run your quality commands (typecheck, tests, lint)
    │          ✗ fail → AI diagnosis → autofix → retry
    ▼
⑤ REVIEW ──── AI code review (fresh session, no build bias)
    │
    ▼
⑥ REVIEW-FIX ─ fix Critical and Major findings
    │
    ▼
⑦ SHIP ────── push branch, create PR with Closes #N
```

## Quick Start

**Prerequisites:** A GitHub repo + an Anthropic API key (or [compatible provider](docs/LITELLM.md) key).

For local CLI usage, you also need: Node.js >= 22, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), [GitHub CLI](https://cli.github.com/), git.

### 1. Set up GitHub

Add your API key as a secret — via [GitHub web UI](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository) or CLI:

```bash
gh secret set ANTHROPIC_API_KEY --repo owner/repo
```

Then in GitHub: **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"**

### 2. Initialize

Copy the [workflow template](templates/kody.yml) to `.github/workflows/kody.yml` and add a `kody.config.json` to your repo root. Or use the CLI to auto-generate both:

```bash
npm install -g @kody-ade/kody-engine-lite
cd your-project
kody-engine-lite init
```

### 3. Bootstrap

Create a new GitHub issue (e.g., "Setup Kody") and comment:

```
@kody bootstrap
```

This analyzes your codebase with an LLM and generates:
- **Project memory** (`.kody/memory/` — architecture and conventions)
- **Customized step files** (`.kody/steps/` — repo-aware prompts for every stage)
- **GitHub labels** for lifecycle tracking (14 labels)

### 4. Use

Comment on any GitHub issue:

```
@kody
```

Kody picks up the issue and works through the pipeline autonomously. You'll see:
- Labels updating in real-time: `kody:planning` → `kody:building` → `kody:review` → `kody:done`
- Progress comments on the issue at each stage
- A PR with a rich description, passing quality checks, and `Closes #N`

If the task is HIGH-risk, Kody pauses after planning and asks for approval before writing code.

### Switch to a different model (optional)

```json
// kody.config.json
{ "agent": { "provider": "minimax" } }
```

```
# .env
ANTHROPIC_COMPATIBLE_API_KEY=your-key-here
```

Kody auto-starts the LiteLLM proxy. [Full LiteLLM guide →](docs/LITELLM.md)

## Commands

| Command | What it does |
|---------|-------------|
| `@kody` | Run full pipeline on an issue |
| `@kody review` | Review any PR — structured findings + GitHub approve/request-changes |
| `@kody fix` | Re-run from build with human PR feedback + Kody's review as context |
| `@kody fix-ci` | Fix failing CI checks (auto-triggered with loop guard) |
| `@kody rerun` | Resume from failed or paused stage |
| `@kody rerun --from <stage>` | Resume from a specific stage |
| `@kody approve` | Resume after questions or risk gate |
| `@kody bootstrap` | Regenerate project memory and step files |

```bash
kody-engine-lite init [--force]          # Setup repo: workflow + config
kody-engine-lite bootstrap [--force]     # Generate memory + step files + labels
kody-engine-lite run --issue-number 42 --local --cwd ./project
kody-engine-lite run --task "Add retry utility" --local
kody-engine-lite review --pr-number 42   # Standalone PR review
kody-engine-lite fix --issue-number 42 --feedback "Use middleware pattern"
kody-engine-lite fix-ci --pr-number 42
kody-engine-lite rerun --issue-number 42 --from verify
```

[Full CLI reference with all flags and options →](docs/CLI.md)

## Key Features

- **Repo-Aware Step Files** — auto-generated prompts with your repo's patterns, gaps, and acceptance criteria ([details](docs/FEATURES.md#repo-aware-step-files-kodysteps))
- **Standalone PR Review** — `@kody review` on any PR for structured code review with GitHub approve/request-changes ([details](docs/FEATURES.md#standalone-pr-review))
- **Shared Sessions** — stages share Claude Code sessions, no cold-start re-exploration ([details](docs/FEATURES.md#shared-sessions))
- **Risk Gate** — HIGH-risk tasks pause for human approval before building ([details](docs/FEATURES.md#risk-gate))
- **AI Failure Diagnosis** — classifies errors as fixable/infrastructure/pre-existing/abort before retry ([details](docs/FEATURES.md#ai-powered-failure-diagnosis))
- **Question Gates** — asks product/architecture questions when the task is unclear ([details](docs/FEATURES.md#question-gates))
- **Auto Fix-CI** — CI fails on a PR? Kody fetches logs, diagnoses, and pushes a fix ([details](docs/FEATURES.md#auto-fix-ci))
- **Pattern Discovery** — searches for existing patterns before proposing new ones ([details](docs/FEATURES.md#pattern-discovery))
- **Decision Memory** — architectural decisions extracted from reviews persist across tasks ([details](docs/FEATURES.md#decision-memory))
- **Auto-Learning** — extracts coding conventions from each successful run ([details](docs/FEATURES.md#auto-learning-memory))
- **Retrospective** — analyzes each run, identifies patterns, suggests improvements ([details](docs/FEATURES.md#retrospective-system))
- **Anthropic-Compatible Models** — route through LiteLLM to use other providers like MiniMax, Gemini, etc. ([setup guide](docs/LITELLM.md))

## Documentation

**Understand Kody:** [About](docs/ABOUT.md) · [Features](docs/FEATURES.md) · [Pipeline](docs/PIPELINE.md) · [Comparison](docs/COMPARISON.md)

**Set up & use:** [CLI](docs/CLI.md) · [Configuration](docs/CONFIGURATION.md) · [Bootstrap](docs/BOOTSTRAP.md) · [LiteLLM](docs/LITELLM.md)

**Reference:** [Architecture](docs/ARCHITECTURE.md) · [FAQ](docs/FAQ.md)

## License

MIT
