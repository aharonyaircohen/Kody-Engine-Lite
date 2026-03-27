# Kody Engine Lite

**Issue → PR in one command.** Comment `@kody` on a GitHub issue and Kody autonomously classifies, plans, builds, tests, reviews, fixes, and ships a pull request.

Kody is a 7-stage autonomous SDLC pipeline that runs in GitHub Actions. It uses Claude Code (or any LLM via LiteLLM) to turn issues into production-ready PRs — with quality gates, AI-powered failure diagnosis, risk-based human approval, and self-improving memory.

## Pipeline

```
                        ┌─────────────────────────────────────────────────────────┐
                        │                    @kody on issue                        │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │  ① TASKIFY                                              │
                        │  Classify task, detect complexity, ask questions         │
                        │  Tier: cheap │ Output: task.json                        │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                                    ┌────────────▼────────────┐
                                    │  LOW?  skip to ④        │
                                    │  MEDIUM?  continue      │
                                    │  HIGH?  continue        │
                                    └────────────┬────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │  ② PLAN                                                 │
                        │  TDD implementation plan (deep reasoning)               │
                        │  Tier: strong │ Output: plan.md                         │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                                    ┌────────────▼────────────┐
                                    │  HIGH risk?             │
                                    │  🛑 Pause for approval  │──── @kody approve
                                    └────────────┬────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │  ③ BUILD                                                │
                        │  Implement code via Claude Code tools                   │
                        │  Tier: mid │ Output: code changes + git commit          │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │  ④ VERIFY                                               │
                        │  typecheck + tests + lint                               │
                        │  ┌──────────────────────────────────────────────┐       │
                        │  │  Fail? → AI diagnosis → autofix → retry ×2  │       │
                        │  └──────────────────────────────────────────────┘       │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │  ⑤ REVIEW                                               │
                        │  Code review: PASS/FAIL + Critical/Major/Minor          │
                        │  Tier: strong │ Output: review.md                       │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │  ⑥ REVIEW-FIX                                           │
                        │  Fix Critical and Major findings                        │
                        │  Tier: mid │ Output: code changes + git commit          │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │  ⑦ SHIP                                                 │
                        │  Push branch + create PR with Closes #N                 │
                        │  Output: ship.md + PR link                              │
                        └────────────────────────┬────────────────────────────────┘
                                                 │
                        ┌────────────────────────▼────────────────────────────────┐
                        │                ✅ PR created & ready for review          │
                        └─────────────────────────────────────────────────────────┘
```

Each stage runs in a **fresh context window** with **accumulated context** from previous stages — so complex tasks (auth systems, CRUD features, API clients) don't lose track of earlier decisions.

[Pipeline details →](docs/PIPELINE.md)

## Why Kody?

Most AI coding tools are **autocomplete** (Copilot) or **chat-based** (Cursor, Cline). You still drive. Kody is different: it's an **autonomous pipeline** that takes an issue and delivers a tested, reviewed PR — even for complex, multi-file features that single-agent tools choke on.

| | Kody | Copilot Workspace | Devin | Cursor Agent |
|---|---|---|---|---|
| **Runs in CI** | GitHub Actions | GitHub Cloud | Devin Cloud | Local IDE |
| **Fire and forget** | Comment `@kody`, walk away | Must interact | Must interact | Must be open |
| **Quality gates** | typecheck + tests + lint + AI diagnosis + auto-retry | Basic | Runs tests | Runs tests |
| **Risk gate** | Pauses HIGH-risk for human approval | No | No | No |
| **Model flexible** | Any LLM via LiteLLM | GitHub models only | Proprietary | Cursor models |
| **Open source** | MIT | Proprietary | Proprietary | Proprietary |
| **Accumulated context** | Curated context flows between stages | Single bloated conversation | Single agent | Single agent |
| **Complex tasks** | Full auth system: 7 stages + 3 autofix retries | Struggles with large scope | Better | Struggles with large scope |
| **Cost** | Your API costs only | $10-39/month | $20-500/month | Subscription |

[Full comparison →](docs/COMPARISON.md)

## Quick Start

```bash
# 1. Install
npm install -g @kody-ade/kody-engine-lite

# 2. Set up GitHub secret
gh secret set ANTHROPIC_API_KEY --repo owner/repo
# Settings → Actions → "Allow GitHub Actions to create and approve pull requests"

# 3. Initialize (auto-detects, commits, and pushes)
cd your-project
kody-engine-lite init

# 4. Comment on any issue
@kody
```

`init` spawns Claude Code to analyze your project and generates: workflow file, config with auto-detected quality commands, project memory (architecture + conventions), 14 GitHub labels — then commits and pushes everything.

**Prerequisites:** Node.js >= 22, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), [GitHub CLI](https://cli.github.com/), git

## Commands

### GitHub Comments

```bash
@kody                              # Full pipeline
@kody approve                      # Resume after questions or risk gate
@kody fix                          # Re-build (comment body = feedback)
@kody rerun --from <stage>         # Resume from specific stage
```

### CLI

```bash
kody-engine-lite run --issue-number 42 --local --cwd ./project
kody-engine-lite run --task "Add retry utility" --local
kody-engine-lite fix --issue-number 42 --feedback "Use middleware pattern"
kody-engine-lite rerun --issue-number 42 --from verify
kody-engine-lite status --task-id 42-260327-102254
kody-engine-lite init [--force]
```

## Key Features

- **Risk Gate** — HIGH-risk tasks pause for human plan approval before building ([details](docs/FEATURES.md#risk-gate))
- **AI Failure Diagnosis** — classifies errors as fixable/infrastructure/pre-existing/abort before retry ([details](docs/FEATURES.md#ai-powered-failure-diagnosis))
- **Question Gates** — asks product/architecture questions when the task is unclear ([details](docs/FEATURES.md#question-gates))
- **Accumulated Context** — each stage passes curated context to the next — fresh window, shared knowledge ([details](docs/FEATURES.md#accumulated-context))
- **Retrospective** — analyzes each run, identifies patterns, suggests improvements ([details](docs/FEATURES.md#retrospective-system))
- **Auto-Learning** — extracts coding conventions from each successful run ([details](docs/FEATURES.md#auto-learning-memory))
- **Any LLM** — route through LiteLLM to use MiniMax, GPT, Gemini, local models ([setup guide](docs/LITELLM.md))

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Pipeline](docs/PIPELINE.md) | Stage details, complexity skipping, accumulated context, artifacts |
| [Features](docs/FEATURES.md) | Risk gate, diagnosis, retrospective, auto-learn, labels |
| [LiteLLM](docs/LITELLM.md) | Non-Anthropic model setup, auto-start, tested providers |
| [Configuration](docs/CONFIGURATION.md) | Full config reference, env vars, workflow setup |
| [Comparison](docs/COMPARISON.md) | vs Copilot, Devin, Cursor, Cline, SWE-agent, OpenHands |
| [Architecture](docs/ARCHITECTURE.md) | Source tree, state machine diagram, development guide |
| [FAQ](docs/FAQ.md) | Common questions about usage, models, security, cost |

## License

MIT
