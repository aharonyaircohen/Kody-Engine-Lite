# Comparison with Other Tools

## Overview

| Tool | Type | Open Source | Model Flexible | CI Native | Fire & Forget | Cost |
|------|------|-------------|---------------|-----------|--------------|------|
| **Kody** | SDLC Pipeline | MIT | Any via LiteLLM | GitHub Actions | Yes | Free with free-tier models |
| Copilot Workspace | Interactive | No | GitHub models | GitHub Cloud | No | $10-39/mo |
| Devin | Autonomous Agent | No | Proprietary | Cloud | Partially | $20-500/mo |
| Cursor Agent | IDE Agent | No | Cursor models | No | No | Subscription |
| Cline | VS Code Extension | Yes | Any LLM | No | No | API costs |
| OpenHands | Autonomous Agent | Apache 2.0 | Any LLM | Docker | Partially | API costs |
| SWE-agent | Research Agent | MIT | Any LLM | Basic | Yes | API costs |

## Detailed Comparisons

### vs GitHub Copilot Workspace

| Category | Kody | Copilot Workspace |
|----------|------|-------------------|
| **Type** | Autonomous pipeline | Interactive assistant |
| **Trigger** | `@kody` on any issue | Open workspace from issue |
| **Runs where** | GitHub Actions (CI) | GitHub Cloud |
| **Autonomous** | Yes — fire and forget | No — requires guidance |
| **Pipeline stages** | 7 with quality gates | Plan + implement |
| **Shared sessions** | Yes (no cold starts between stages) | Single conversation |
| **Quality gates** | typecheck + tests + lint + AI diagnosis | Basic validation |
| **Risk gate** | Yes — pauses HIGH-risk for approval | No |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Basic retry |
| **Repo-aware prompts** | Yes — auto-generated per stage | No — generic prompts |
| **Project memory** | Yes — auto-learns conventions | No |
| **Checkpoints** | Rerun from any stage | No |
| **Model flexible** | Any via LiteLLM | GitHub models only |
| **Open source** | MIT | Proprietary |
| **Cost** | Free with free-tier models | $10-39/month |

> **Choose Copilot Workspace** for interactive pair programming with tight GitHub integration.
> **Choose Kody** for autonomous issue-to-PR automation with quality gates and model flexibility.

---

### vs Devin

| Category | Kody | Devin |
|----------|------|-------|
| **Type** | Structured pipeline | Autonomous agent |
| **Architecture** | 7 stages with artifacts | Single agent |
| **Transparency** | Full — artifacts at every stage | Limited |
| **Self-hosted** | Yes — your infra, your keys | No — cloud only |
| **Pipeline stages** | 7 with quality gates | Single pass |
| **Shared sessions** | Yes (grouped stages) | Single conversation |
| **Quality gates** | typecheck + tests + lint + AI diagnosis | No structured gates |
| **Risk gate** | Yes — pauses HIGH-risk for approval | No |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Basic retry |
| **Repo-aware prompts** | Yes — auto-generated per stage | No — generic prompts |
| **Project memory** | Yes — auto-learns conventions | Limited |
| **Checkpoints** | Rerun from any stage | No |
| **Concurrency** | Multiple issues in parallel (GitHub Actions) | Multiple Devins (paid) |
| **Model flexible** | Any via LiteLLM | Proprietary only |
| **Open source** | MIT | Proprietary |
| **Cost** | Free with free-tier models | $20-500/month |

> **Choose Devin** for a fully managed autonomous coding environment.
> **Choose Kody** for transparency, self-hosting, model flexibility, and structured quality gates.

---

### vs Cursor Agent / Cline

| Category | Kody | Cursor Agent | Cline |
|----------|------|-------------|-------|
| **Type** | Autonomous pipeline | IDE agent | IDE agent |
| **Runs where** | GitHub Actions (CI) | Local IDE | Local IDE |
| **Requires IDE open** | No | Yes | Yes |
| **Autonomous** | Yes — fire and forget | Partially | Partially |
| **Pipeline stages** | 7 with quality gates | Single pass | Single pass |
| **Quality gates** | typecheck + tests + lint + AI diagnosis | No | No |
| **Risk gate** | Yes | No | No |
| **Failure handling** | 5-way AI diagnosis + autofix | No | No |
| **Repo-aware prompts** | Yes — auto-generated per stage | No | No |
| **Project memory** | Yes — auto-learns conventions | Session-based | Session-based |
| **Checkpoints** | Rerun from any stage | No | No |
| **GitHub integration** | Native (issue → PR) | Manual | Manual |
| **Batch processing** | Multiple issues in parallel | One at a time | One at a time |
| **Model flexible** | Any via LiteLLM | Cursor models | Any LLM |
| **Open source** | MIT | Proprietary | Yes |
| **Cost** | Free with free-tier models | Subscription | API costs |

> **Choose Cursor/Cline** for AI-assisted coding while you're at your desk.
> **Choose Kody** to delegate tasks and walk away — no IDE required.

---

### vs OpenHands

| Category | Kody | OpenHands |
|----------|------|-----------|
| **Type** | SDLC pipeline | Autonomous coding agent |
| **Focus** | Issue → PR automation | General-purpose coding |
| **Runs where** | GitHub Actions (zero infra) | Docker/Kubernetes sandbox |
| **Setup** | `npm install` + `init` (2 min) | Docker compose + sandbox config |
| **Autonomous** | Yes — fire and forget | Partially |
| **Pipeline stages** | 7 with quality gates | Single agent loop |
| **Shared sessions** | Yes (grouped stages, no cold starts) | Single conversation |
| **Quality gates** | typecheck + tests + lint + AI diagnosis | No structured gates |
| **Risk gate** | Yes — pauses HIGH-risk for approval | No |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Retry within agent loop |
| **Repo-aware prompts** | Yes — auto-generated per stage | No — generic prompts |
| **Project memory** | Yes — auto-learns conventions | No persistent memory |
| **Checkpoints** | Rerun from any stage | Start over on failure |
| **Review** | Dedicated stage with fresh session | Self-review in same context |
| **GitHub integration** | Native — issues, PRs, labels, comments | Via integrations |
| **Model flexible** | Any via LiteLLM | Any LLM |
| **Open source** | MIT | Apache 2.0 |
| **Community** | Early stage | 65K+ stars |
| **Cost** | Free with free-tier models | API costs + infra |

> **Choose OpenHands** for general-purpose autonomous coding with a web IDE and broad tooling.
> **Choose Kody** for structured issue-to-PR automation with quality gates, repo-aware prompts, and zero infrastructure.

---

### vs SWE-agent

| Category | Kody | SWE-agent |
|----------|------|-----------|
| **Type** | Production SDLC pipeline | Research agent |
| **Focus** | Issue → PR automation | Benchmarking |
| **Pipeline stages** | 7 with quality gates | Single agent loop |
| **Quality gates** | typecheck + tests + lint + AI diagnosis | Test execution only |
| **Failure handling** | 5-way AI diagnosis + autofix | Basic retry |
| **Repo-aware prompts** | Yes — auto-generated per stage | No |
| **Project memory** | Yes — auto-learns conventions | No |
| **Retrospective** | Yes — AI-powered run analysis | No |
| **GitHub integration** | Native (issues, PRs, labels, comments) | Basic |
| **Model flexible** | Any via LiteLLM | Any LLM |
| **Open source** | MIT | MIT |
| **Community** | Early stage | Academic (NeurIPS 2024) |
| **Production ready** | Yes | Research-focused |

> **Choose SWE-agent** for research and benchmarking.
> **Choose Kody** for production SDLC automation with structured stages and quality gates.

---

## Why Pipelines Beat Single Agents on Complex Tasks

| Problem | Single Agent | Kody Pipeline |
|---------|-------------|---------------|
| **Context management** | One long conversation that bloats over time | Shared sessions within groups + context.md across groups |
| **Error cascading** | Writes broken code, tries to fix in same context | Quality gate catches errors between stages, AI diagnoses before retry |
| **No checkpoint** | Fails midway → start over | Rerun from any stage — keep what worked |
| **No oversight** | Fully autonomous or needs constant approval | Risk gate pauses only HIGH-risk tasks at plan stage |
| **Review quality** | Self-review in same context (bias) | Fresh session for review — clean perspective |

### Real-World Example: Auth System (#29)

A full authentication system built end-to-end with MiniMax via LiteLLM:

- **Scope:** JWT service, session store, user store with lockout, auth middleware, role guard, 5 API routes, 3 UI pages, auth context, shared components, tests
- **Complexity:** HIGH (auto-detected), all 7 stages ran
- **Sessions:** explore (taskify+plan), build (build+autofix), review (fresh)
- **Verify:** Failed twice (lint errors in React code), AI diagnosed as "fixable", autofix agent fixed both times, passed on attempt 3
- **Review:** PASS with minor findings, review-fix applied
- **Result:** PR created with working code, tests passing

## Kody's Unique Advantages

1. **Repo-aware step files** — auto-generated per-stage instructions grounded in your actual code patterns, gaps, and acceptance criteria. [Learn more →](FEATURES.md#repo-aware-step-files-kodysteps)
2. **Incremental codebase improvement** — step files encode known gaps; every task that touches related code fixes them
3. **Shared sessions** — no cold starts within stage groups, fresh sessions across groups, context.md carries summaries
4. **AI failure diagnosis** — classifies errors (fixable/infrastructure/pre-existing/abort/flaky) before deciding to retry, skip, or abort
5. **Risk gate** — HIGH-risk tasks pause for human approval after plan, before code
6. **Self-improving memory** — each successful run extracts coding conventions for future runs
7. **Model agnostic** — any LLM via LiteLLM, switch providers without code changes
8. **Free option** — use free-tier models (Gemini, etc.) for zero-cost autonomous SDLC
9. **Runs in CI** — no IDE, no cloud VM, no subscription — just GitHub Actions
10. **Rerun from any stage** — don't redo a 20-minute build when only review-fix failed
