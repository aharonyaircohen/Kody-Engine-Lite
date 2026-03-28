# Kody Engine Lite

[![npm](https://img.shields.io/npm/v/@kody-ade/kody-engine-lite)](https://www.npmjs.com/package/@kody-ade/kody-engine-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Issue → PR in one command.** Comment `@kody` on a GitHub issue and Kody autonomously classifies, plans, builds, tests, reviews, fixes, and ships a pull request.

Kody is a 7-stage autonomous SDLC pipeline that runs in GitHub Actions. It uses Claude Code (or any LLM via LiteLLM) to turn issues into production-ready PRs — with quality gates, AI-powered failure diagnosis, risk-based human approval, and shared context between stages.

## Why Kody?

Most AI coding tools are **autocomplete** (Copilot) or **chat-based** (Cursor, Cline). You still drive. Kody is an **autonomous pipeline** — comment `@kody`, walk away, come back to a PR.

| | Kody | Copilot Workspace | Devin | Cursor Agent |
|---|---|---|---|---|
| **Repo-aware instructions** | AI-customized per-stage prompts with your repo's patterns, gaps, and acceptance criteria | Generic prompts | Generic prompts | Generic prompts |
| **Runs in CI** | GitHub Actions | GitHub Cloud | Devin Cloud | Local IDE |
| **Fire and forget** | Yes | No — interactive | Partially | No — IDE must be open |
| **Pipeline stages** | 7 stages with quality gates | Plan → implement | Single agent | Single agent |
| **Shared sessions** | Stages share Claude Code sessions (no cold starts) | Single conversation | Single conversation | Single conversation |
| **Risk gate** | Pauses HIGH-risk for human approval | No | No | No |
| **AI failure diagnosis** | Classifies errors before retry (fixable/infra/abort) | No | No | No |
| **Incremental codebase improvement** | Step files encode gaps to fix — every task raises quality | No | No | No |
| **Model flexible** | Any LLM via LiteLLM | GitHub models only | Proprietary | Cursor models |
| **Open source** | MIT | Proprietary | Proprietary | Proprietary |
| **Cost** | **Free** with free-tier models (Gemini, etc.) or pay-per-use with any LLM | $10-39/month | $20-500/month | Subscription |

[Full comparison →](docs/COMPARISON.md)

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
                │  LOW?  skip to ④        │
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
- **GitHub labels** for lifecycle tracking

Then commits and pushes everything.

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
MINIMAX_API_KEY=your-key-here
```

That's it. Kody auto-starts the LiteLLM proxy and loads API keys from `.env`. For advanced routing (different models per tier, custom config), add a `litellm-config.yaml`. [Full LiteLLM guide →](docs/LITELLM.md)

## Commands

### GitHub Comments

| Command | What it does |
|---------|-------------|
| `@kody` | Run full pipeline |
| `@kody approve` | Resume after questions or risk gate |
| `@kody fix` | Re-run from build stage. Write feedback in the comment body — it gets injected into the build prompt |
| `@kody rerun` | Resume from the failed or paused stage |
| `@kody rerun --from <stage>` | Resume from a specific stage |
| `@kody bootstrap` | Regenerate project memory and step files |

### CLI

```bash
kody-engine-lite init [--force]          # Setup repo: workflow, config, memory, step files
kody-engine-lite bootstrap               # Regenerate memory + step files (runs in GH Actions)
kody-engine-lite run --issue-number 42 --local --cwd ./project
kody-engine-lite run --task "Add retry utility" --local
kody-engine-lite fix --issue-number 42 --feedback "Use middleware pattern"
kody-engine-lite rerun --issue-number 42 --from verify
kody-engine-lite status --task-id 42-260327-102254
```

## Key Features

### Repo-Aware Step Files (`.kody/steps/`)

**This is what separates Kody from every other AI coding tool.**

Most AI tools send the same generic prompt regardless of whether they're working on a Next.js app, a Go microservice, or a Python ML pipeline. Kody generates **customized instruction files for every pipeline stage**, tailored to your specific repository.

During `kody init`, Kody analyzes your codebase — your frameworks, patterns, conventions, file structure, even your anti-patterns — and produces 6 step files in `.kody/steps/`:

| Step File | What It Controls |
|-----------|-----------------|
| `taskify.md` | How tasks are classified and scoped for this repo |
| `plan.md` | Planning guidelines with your repo's architecture in mind |
| `build.md` | Coding instructions with your actual patterns as examples |
| `autofix.md` | How to fix verification failures using your toolchain |
| `review.md` | Review checklist calibrated to your repo's quality bar |
| `review-fix.md` | How to address review findings in your codebase |

Each step file contains three repo-specific sections:
- **Repo Patterns** — real code examples from your codebase (file paths, function signatures, snippets) showing what "good" looks like in your project
- **Improvement Areas** — gaps, anti-patterns, and inconsistencies the AI should fix when it touches related code (e.g., "collections missing access control", "services not using DI")
- **Acceptance Criteria** — a concrete checklist that defines "done" for each stage in your specific repo

**Why this matters:**
- Code produced by Kody **matches your existing patterns** — same naming, same abstractions, same file organization
- Known gaps get **incrementally fixed** — every task that touches a weak area leaves it better
- Quality bar is **explicit and auditable** — acceptance criteria are version-controlled in your repo, not hidden in a prompt
- **You own and customize** the instructions — edit `.kody/steps/build.md` to change how Kody writes code, no engine changes needed
- Re-run `kody init --force` after major refactors to **regenerate** step files from current state

```
# Example: .kody/steps/build.md (auto-generated, then customizable)
---
name: build
...
---
<original engine prompt preserved>

## Repo Patterns
**Collection pattern** (`src/collections/certificates.ts`):
- Always cast `relationTo` with `as CollectionSlug`
- Register every new collection in `src/payload.config.ts`

## Improvement Areas
- Collections missing access control — add `access` guards when touching
- Run `pnpm payload generate:types` after any schema change

## Acceptance Criteria
- [ ] `pnpm tsc --noEmit` exits with zero errors
- [ ] All new collections include explicit access control
- [ ] User-supplied strings sanitized via `src/security/sanitizers.ts`
```

### Other Features

- **Shared Sessions** — stages in the same group share a Claude Code session, eliminating cold-start codebase re-exploration ([details](docs/FEATURES.md#shared-sessions))
- **Risk Gate** — HIGH-risk tasks pause for human plan approval before building ([details](docs/FEATURES.md#risk-gate))
- **AI Failure Diagnosis** — classifies errors as fixable/infrastructure/pre-existing/abort before retry ([details](docs/FEATURES.md#ai-powered-failure-diagnosis))
- **Question Gates** — asks product/architecture questions when the task is unclear ([details](docs/FEATURES.md#question-gates))
- **Any LLM** — route through LiteLLM to use MiniMax, GPT, Gemini, local models ([setup guide](docs/LITELLM.md))
- **Retrospective** — analyzes each run, identifies patterns, suggests improvements ([details](docs/FEATURES.md#retrospective-system))
- **Auto-Learning** — extracts coding conventions from each successful run ([details](docs/FEATURES.md#auto-learning-memory))

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Pipeline](docs/PIPELINE.md) | Stage details, shared sessions, complexity skipping, artifacts |
| [Features](docs/FEATURES.md) | Risk gate, diagnosis, sessions, retrospective, auto-learn, labels |
| [LiteLLM](docs/LITELLM.md) | Non-Anthropic model setup, auto-start, tested providers |
| [Configuration](docs/CONFIGURATION.md) | Full config reference, env vars, workflow setup |
| [Comparison](docs/COMPARISON.md) | vs Copilot, Devin, Cursor, Cline, SWE-agent, OpenHands |
| [Architecture](docs/ARCHITECTURE.md) | Source tree, state machine diagram, development guide |
| [FAQ](docs/FAQ.md) | Common questions about usage, models, security, cost |

## License

MIT
