# Kody Engine Lite

[![npm](https://img.shields.io/npm/v/@kody-ade/kody-engine-lite)](https://www.npmjs.com/package/@kody-ade/kody-engine-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Issue → PR in one command.** Comment `@kody` on a GitHub issue and Kody autonomously classifies, plans, builds, tests, reviews, fixes, and ships a pull request.

Kody is a 7-stage autonomous SDLC pipeline that runs in GitHub Actions. It uses Claude Code (or any LLM via LiteLLM) to turn issues into production-ready PRs — with quality gates, AI-powered failure diagnosis, risk-based human approval, and shared context between stages.

> **Kody is the only AI coding tool that generates repo-customized prompts.** Every other tool sends the same generic instructions regardless of your codebase. Kody analyzes your repo's patterns, conventions, and gaps — then generates tailored instruction files for every pipeline stage. The AI writes code that looks like it belongs in your project because it was taught *from* your project. [Learn more →](docs/FEATURES.md#repo-aware-step-files-kodysteps)

## Why Kody?

Most AI coding tools are **autocomplete** (Copilot) or **chat-based** (Cursor, Cline). You still drive. Kody is an **autonomous pipeline** — comment `@kody`, walk away, come back to a PR.

- **Repo-aware prompts** — auto-generated step files with your repo's patterns, gaps, and acceptance criteria
- **7 stages with quality gates** — not a single agent conversation
- **Fire and forget** — runs in GitHub Actions, no IDE required
- **Any LLM** — route through LiteLLM to use MiniMax, GPT, Gemini, or local models
- **Free** with free-tier models — no subscriptions, no per-seat pricing

[How Kody compares to Copilot, Devin, Cursor, OpenHands, and others →](docs/COMPARISON.md)

## Pipeline

```
  ┌─────────────────────────────────────────────────────────────┐
  │                      @kody on issue                         │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │  ① TASKIFY         Tier: cheap                              │
  │  Classify task, detect complexity, ask questions → task.json │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                ┌────────────▼────────────┐
                │  LOW?  skip to ③        │
                │  MEDIUM?  continue      │
                │  HIGH?  continue        │
                └────────────┬────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │  ② PLAN            Tier: strong                             │
  │  TDD implementation plan (deep reasoning)        → plan.md  │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                ┌────────────▼────────────┐
                │  HIGH risk?             │
                │  🛑 Pause for approval  │──── @kody approve
                └────────────┬────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │  ③ BUILD           Tier: mid                                │
  │  Implement code via Claude Code tools    → code + git commit│
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │  ④ VERIFY          (deterministic gate)                     │
  │  typecheck + tests + lint                                   │
  │  ┌───────────────────────────────────────────────────┐      │
  │  │  Fail? → AI diagnosis → autofix → retry (up to 2) │      │
  │  └───────────────────────────────────────────────────┘      │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │  ⑤ REVIEW          Tier: strong                             │
  │  Code review: PASS/FAIL + Critical/Major/Minor  → review.md │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │  ⑥ REVIEW-FIX      Tier: mid                               │
  │  Fix Critical and Major findings             → code + commit│
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │  ⑦ SHIP            (deterministic)                          │
  │  Push branch + create PR with Closes #N       → ship.md + PR│
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │                 ✅ PR created & ready for review             │
  └─────────────────────────────────────────────────────────────┘
```

**Tiers are configurable** — cheap/mid/strong map to any model via `modelMap` in config. Defaults: haiku/sonnet/opus. Route to MiniMax, GPT, Gemini, or local models via [LiteLLM](docs/LITELLM.md).

**Shared sessions** — stages in the same group share a Claude Code session: taskify+plan (explore), build+autofix+review-fix (implementation), review (fresh perspective). No cold-start re-exploration between stages.

[Pipeline details →](docs/PIPELINE.md)

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
- **Customized step files** (`.kody/steps/` — see below)
Then commits and pushes everything.

> **Note:** GitHub labels for lifecycle tracking are created automatically during `@kody bootstrap`.

### 4. Use

Comment on any GitHub issue:

```
@kody
```

### Switch to a different model (optional)

Set the `provider` field in `kody.config.json` — Kody auto-generates the LiteLLM config, starts the proxy, and routes all stages through your provider:

```json
// kody.config.json — use MiniMax (or any LLM)
{ "agent": { "provider": "minimax" } }
```

Add the provider's API key to `.env`:
```
ANTHROPIC_COMPATIBLE_API_KEY=your-key-here
```

That's it. Kody auto-starts the LiteLLM proxy and loads API keys from `.env`. For per-tier model control, configure `modelMap` in `kody.config.json`. [Full LiteLLM guide →](docs/LITELLM.md)

## Commands

| Command | What it does |
|---------|-------------|
| `@kody` | Run full pipeline on an issue |
| `@kody approve` | Resume after questions or risk gate |
| `@kody fix` | Re-run from build. Reads PR review comments as context |
| `@kody fix-ci` | Fix failing CI checks (auto-triggered on Kody PRs) |
| `@kody rerun` | Resume from the failed or paused stage |
| `@kody bootstrap` | Regenerate project memory and step files |

```bash
kody-engine-lite init [--force]        # Setup repo
kody-engine-lite run --issue-number 42 --local
kody-engine-lite fix --issue-number 42 --feedback "Use middleware pattern"
kody-engine-lite fix-ci --pr-number 42
kody-engine-lite rerun --issue-number 42 --from verify
```

[Full CLI reference with all flags and options →](docs/CLI.md)

## Key Features

- **[Repo-Aware Step Files](docs/FEATURES.md#repo-aware-step-files-kodysteps)** — auto-generated per-stage instructions grounded in your actual code patterns, gaps, and acceptance criteria. Edit `.kody/steps/*.md` to customize how Kody works in your repo.
- **[Shared Sessions](docs/FEATURES.md#shared-sessions)** — stages in the same group share a Claude Code session, eliminating cold-start re-exploration
- **[Risk Gate](docs/FEATURES.md#risk-gate)** — HIGH-risk tasks pause for human approval before building
- **[AI Failure Diagnosis](docs/FEATURES.md#ai-powered-failure-diagnosis)** — classifies errors (fixable/infrastructure/pre-existing/abort) before retry
- **[Question Gates](docs/FEATURES.md#question-gates)** — asks product/architecture questions when the task is unclear
- **[Any LLM](docs/LITELLM.md)** — route through LiteLLM to use MiniMax, GPT, Gemini, local models
- **[Retrospective](docs/FEATURES.md#retrospective-system)** — analyzes each run, identifies patterns, suggests improvements
- **[Auto-Learning](docs/FEATURES.md#auto-learning-memory)** — extracts coding conventions from each successful run
- **[Pattern Discovery](docs/FEATURES.md#pattern-discovery)** — plan stage searches for existing patterns before proposing new approaches
- **[Decision Memory](docs/FEATURES.md#decision-memory)** — architectural decisions from code reviews are saved and enforced in future tasks

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Pipeline](docs/PIPELINE.md) | Stage details, shared sessions, complexity skipping, artifacts |
| [Bootstrap](docs/BOOTSTRAP.md) | Project memory, step files, labels — what bootstrap generates and when to run it |
| [Features](docs/FEATURES.md) | Risk gate, diagnosis, sessions, retrospective, auto-learn, pattern discovery, decision memory, PR feedback |
| [LiteLLM](docs/LITELLM.md) | Non-Anthropic model setup, auto-start, tested providers |
| [CLI](docs/CLI.md) | Full command reference — all flags, env vars, and examples |
| [Configuration](docs/CONFIGURATION.md) | Config file reference, env vars, workflow setup |
| [Comparison](docs/COMPARISON.md) | vs Copilot, Devin, Cursor, Cline, OpenHands, SWE-agent |
| [Architecture](docs/ARCHITECTURE.md) | Source tree, state machine diagram, development guide |
| [FAQ](docs/FAQ.md) | Common questions about usage, models, security, cost |

## License

MIT
