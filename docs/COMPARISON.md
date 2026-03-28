# Comparison with Other Tools

## Overview

| Tool | Type | Open Source | Model Flexible | CI Native | Fire & Forget | Cost |
|------|------|-------------|---------------|-----------|--------------|------|
| **Kody** | SDLC Pipeline | MIT | Any via LiteLLM | GitHub Actions | Yes | Free with free-tier models |

**Kody is the only tool that generates repo-customized prompts** — every other tool uses the same generic instructions regardless of your codebase's patterns, conventions, and gaps.
| Copilot Workspace | Interactive | No | GitHub models | GitHub Cloud | No | $10-39/mo |
| Devin | Autonomous Agent | No | Proprietary | Cloud | Partially | $20-500/mo |
| Cursor Agent | IDE Agent | No | Cursor models | No | No | Subscription |
| Cline | VS Code Extension | Yes | Any LLM | No | No | API costs |
| OpenHands | Autonomous Agent | Apache 2.0 | Any LLM | Docker | Partially | API costs |
| SWE-agent | Research Agent | MIT | Any LLM | Basic | Yes | API costs |
| Sweep AI | SaaS Pipeline | Partial | Multiple LLMs | GitHub | Yes | SaaS pricing |

## Detailed Comparisons

### vs GitHub Copilot Workspace

| | Kody | Copilot Workspace |
|---|---|---|
| **Trigger** | `@kody` on any issue | Open workspace from issue |
| **Runs where** | CI (GitHub Actions) | GitHub Cloud |
| **Autonomous** | Fully — fire and forget | Interactive — requires guidance |
| **Pipeline** | 7 structured stages with artifacts | Plan → implement |
| **Sessions** | Shared within stage groups (no cold starts) | Single conversation |
| **Quality gates** | typecheck + tests + lint + AI diagnosis | Basic validation |
| **Risk gate** | Pauses HIGH-risk for approval | No |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Basic retry |
| **Memory** | Auto-learns conventions per project | No project memory |
| **Models** | Any via LiteLLM | GitHub models only |
| **Source** | MIT open source | Proprietary |
| **Cost** | Free with free-tier models, or ~$0.30-8/task with paid models | $10-39/month |

**Choose Copilot Workspace** when you want interactive pair programming with tight GitHub integration.

**Choose Kody** when you want autonomous issue-to-PR automation with quality gates, failure diagnosis, and model flexibility — at zero cost with free-tier models.

### vs Devin

| | Kody | Devin |
|---|---|---|
| **Architecture** | Structured 7-stage pipeline | Single autonomous agent |
| **Transparency** | Artifacts at every stage (task.json, plan.md, review.md) | Less transparent |
| **Self-hosted** | Yes — your infra, your keys | Cloud only |
| **Models** | Any LLM via LiteLLM | Proprietary (Devin 2.0) |
| **Concurrency** | Multiple issues in parallel (GitHub Actions) | Multiple Devins (paid) |
| **Cost** | Free with free-tier models, or ~$0.30-8/task with paid models | $20/mo (Core) to $500/mo (Team) |
| **Failure handling** | AI diagnosis with 5 classifications | Retry |
| **Human oversight** | Risk gate + labels + issue comments | Interactive steering |

**Choose Devin** when you want a fully managed autonomous coding environment for complex multi-step tasks.

**Choose Kody** when you want transparency (staged artifacts), self-hosting, model flexibility, and structured quality gates in your existing GitHub workflow.

### vs Cursor Agent / Cline

| | Kody | Cursor/Cline |
|---|---|---|
| **Runs in** | CI (GitHub Actions) | Local IDE |
| **Requires IDE** | No | Yes (must be open) |
| **CI integration** | Native (issue → PR) | Manual |
| **Batch processing** | Multiple issues in parallel | One at a time |
| **Human oversight** | Risk gate at plan stage | Approval per action (Cline) |
| **Project memory** | Auto-learning conventions | Session-based |
| **Model flexibility** | Any via LiteLLM | Cursor models / Any (Cline) |

**Choose Cursor/Cline** when you want an AI coding assistant while you're working at your desk.

**Choose Kody** when you want to delegate tasks and walk away — CI-level automation that doesn't need your IDE open.

### vs SWE-agent / OpenHands

| | Kody | SWE-agent | OpenHands |
|---|---|---|---|
| **Focus** | Production SDLC pipeline | Research benchmark | General autonomous agent |
| **Pipeline** | 7 structured stages | Single agent loop | Single agent loop |
| **GitHub integration** | Native (issues, PRs, labels, comments) | Basic | Basic |
| **Quality gates** | Built-in (typecheck, lint, test + AI diagnosis) | Test execution | Test execution |
| **Memory** | Auto-learning conventions | No | No |
| **Retrospective** | AI-powered run analysis | No | No |
| **Production ready** | Yes | Research-focused | Growing |
| **Community** | Early stage | Academic (NeurIPS 2024) | 65K+ stars |

**Choose SWE-agent** for research and benchmarking autonomous coding capabilities.

**Choose OpenHands** for a general-purpose autonomous agent with a large community.

**Choose Kody** for a production SDLC pipeline with structured stages, quality gates, and GitHub-native workflow.

## Why Pipelines Handle Complex Tasks Better Than Single Agents

Single-agent tools run one conversation per task. For simple tasks, that's fine. For complex multi-file features, it breaks down:

| Problem | Single Agent | Kody Pipeline |
|---------|-------------|---------------|
| **Context management** | One long conversation that accumulates over time | Shared sessions within groups + context.md across groups |
| **Error cascading** | Agent writes broken code, tries to fix it in the same context | Quality gate catches errors between stages, AI diagnoses before retry |
| **No checkpoint** | If it fails midway, start over | Rerun from any stage — keep what worked |
| **No oversight** | Either fully autonomous or needs constant approval | Risk gate pauses only HIGH-risk tasks at the plan stage |
| **Review quality** | Self-reviewing in the same context introduces bias | Fresh session for review — clean perspective on the code |

### Real-World Example: Auth System (#29)

A full authentication system built end-to-end with MiniMax via LiteLLM:

- **Scope:** JWT service, session store, user store with lockout, auth middleware, role guard, 5 API routes, 3 UI pages, auth context, shared components, tests
- **Complexity:** HIGH (auto-detected), all 7 stages ran
- **Sessions:** explore (taskify+plan), build (build+autofix), review (fresh)
- **Verify:** Failed twice (lint errors in React code), AI diagnosed as "fixable", autofix agent fixed both times, passed on attempt 3
- **Review:** PASS with minor findings, review-fix applied
- **Result:** PR created with working code, tests passing

## Kody's Unique Advantages

1. **Repo-aware step files.** Every other tool sends the same generic prompt to every repo. Kody generates customized instruction files (`.kody/steps/`) for each pipeline stage, grounded in your actual code — real patterns, real gaps, real acceptance criteria. The AI writes code that looks like it belongs in your project because it was taught *from* your project. See [Features](FEATURES.md#repo-aware-step-files-kodysteps).

2. **Incremental codebase improvement.** Step files encode known gaps (missing access control, inconsistent error handling, unused DI containers). Every task that touches related code fixes these issues — quality improves organically without dedicated refactoring tickets.

3. **Shared sessions, not bloated context.** Stages in the same group share a Claude Code session (no cold starts). Different groups get fresh sessions (no context pollution). Plus context.md carries structured summaries across all stages.

4. **Handles complex tasks.** Auth systems, CRUD features, API clients — tasks where single-agent tools lose track. Structured stages + shared sessions + quality gates keep the pipeline on track.

5. **AI failure diagnosis.** When tests fail, Kody classifies the error (fixable vs infrastructure vs pre-existing) before deciding whether to retry, skip, or abort.

6. **Risk gate.** HIGH-risk tasks pause for human approval after the plan — before any code is written.

7. **Self-improving memory.** Each successful run extracts coding conventions for future runs.

8. **Model agnostic.** Route through LiteLLM to use any model. Switch providers without changing code.

9. **Completely free option.** Use free-tier models (Google Gemini, etc.) via LiteLLM and pay nothing. No subscriptions, no per-seat pricing — a full autonomous SDLC pipeline at zero cost.

10. **Runs in CI.** No IDE required, no cloud VM, no subscription. Just GitHub Actions and your API key (or free models).

11. **Rerun from any stage.** If review-fix fails, rerun from review-fix. Don't redo the 20-minute build.
