# Kody Engine Lite

[![npm](https://img.shields.io/npm/v/@kody-ade/kody-engine-lite)](https://www.npmjs.com/package/@kody-ade/kody-engine-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**The full dev pipeline around Claude Code. Issue → tested PR. Free and open source.**

Kody wraps Claude Code with a 7-stage autonomous pipeline that classifies, plans, builds, verifies, reviews, fixes, and ships — with quality gates between every stage. It also reviews your PRs on demand. `kody init` bootstraps into any repo, generating customized instructions from YOUR codebase. Run locally or via GitHub Actions. Use Anthropic models or free ones via LiteLLM.

[What makes Kody different →](docs/ABOUT.md) · [Full comparison →](docs/COMPARISON.md)

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
④ VERIFY ──── typecheck + tests + lint
    │          ✗ fail → AI diagnosis → autofix → retry
    ▼
⑤ REVIEW ──── AI code review (fresh session, no build bias)
    │
    ▼
⑥ REVIEW-FIX ─ fix Critical and Major findings
    │
    ▼
⑦ SHIP ────── push branch, create PR, close issue
```

## Quick Start

**Prerequisites:** Node.js >= 22, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), [GitHub CLI](https://cli.github.com/), git

### 1. Install

```bash
npm install -g @kody-ade/kody-engine-lite
```

### 2. Set up GitHub

```bash
gh secret set ANTHROPIC_API_KEY --repo owner/repo
```

Then in GitHub: **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"**

### 3. Initialize

```bash
cd your-project
kody-engine-lite init
```

This analyzes your project and generates:
- **Workflow** (`.github/workflows/kody.yml`)
- **Config** (`kody.config.json` — auto-detected quality commands, git, GitHub settings)
- **Project memory** (`.kody/memory/` — architecture and conventions)
- **Customized step files** (`.kody/steps/` — repo-aware prompts for every stage)

Then commits and pushes everything.

### 4. Use

Comment on any GitHub issue:

```
@kody
```

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
kody-engine-lite init [--force]          # Setup repo: workflow, config, memory, step files
kody-engine-lite bootstrap               # Regenerate memory + step files
kody-engine-lite run --issue-number 42 --local --cwd ./project
kody-engine-lite run --task "Add retry utility" --local
kody-engine-lite review --pr-number 42   # Standalone PR review
kody-engine-lite fix --issue-number 42 --feedback "Use middleware pattern"
kody-engine-lite fix-ci --pr-number 42
kody-engine-lite rerun --issue-number 42 --from verify
```

[Full CLI reference with all flags and options →](docs/CLI.md)

## Key Features

- **Repo-Aware Step Files** — auto-generated prompts with your repo's patterns, gaps, and acceptance criteria ([details](docs/ABOUT.md#repo-aware-step-files))
- **Standalone PR Review** — `@kody review` on any PR for structured code review with GitHub approve/request-changes ([details](docs/ABOUT.md#standalone-pr-review))
- **Shared Sessions** — stages share Claude Code sessions, no cold-start re-exploration ([details](docs/ABOUT.md#shared-sessions))
- **Risk Gate** — HIGH-risk tasks pause for human approval before building ([details](docs/ABOUT.md#risk-gate))
- **AI Failure Diagnosis** — classifies errors as fixable/infrastructure/pre-existing/abort before retry ([details](docs/ABOUT.md#ai-failure-diagnosis))
- **Question Gates** — asks product/architecture questions when the task is unclear ([details](docs/ABOUT.md#question-gates))
- **Auto Fix-CI** — CI fails on a PR? Kody fetches logs, diagnoses, and pushes a fix ([details](docs/ABOUT.md#auto-fix-ci))
- **Pattern Discovery** — searches for existing patterns before proposing new ones ([details](docs/ABOUT.md#pattern-discovery))
- **Decision Memory** — architectural decisions extracted from reviews persist across tasks ([details](docs/ABOUT.md#decision-memory))
- **Auto-Learning** — extracts coding conventions from each successful run ([details](docs/ABOUT.md#auto-learning-memory))
- **Retrospective** — analyzes each run, identifies patterns, suggests improvements ([details](docs/ABOUT.md#retrospective))
- **Any LLM** — route through LiteLLM to use free or paid models ([setup guide](docs/LITELLM.md))

## Documentation

| Doc | What's in it |
|-----|-------------|
| [About](docs/ABOUT.md) | What Kody is, how it works, all features explained, comparison |
| [Pipeline](docs/PIPELINE.md) | Stage details, shared sessions, complexity skipping, artifacts |
| [Bootstrap](docs/BOOTSTRAP.md) | Project memory, step files, labels — what bootstrap generates |
| [Features](docs/FEATURES.md) | Deep dive into each feature with examples |
| [LiteLLM](docs/LITELLM.md) | Non-Anthropic model setup, auto-start, tested providers |
| [CLI](docs/CLI.md) | Full command reference — all flags, env vars, and examples |
| [Configuration](docs/CONFIGURATION.md) | Config file reference, env vars, workflow setup |
| [Comparison](docs/COMPARISON.md) | vs Copilot, Devin, Cursor, Cline, OpenHands, SWE-agent |
| [Architecture](docs/ARCHITECTURE.md) | Source tree, state machine diagram, development guide |
| [FAQ](docs/FAQ.md) | Common questions about usage, models, security, cost |

## License

MIT
