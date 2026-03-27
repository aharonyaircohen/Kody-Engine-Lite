# Comparison with Other Tools

## Overview

| Tool | Type | Open Source | Model Flexible | CI Native | Fire & Forget | Cost |
|------|------|-------------|---------------|-----------|--------------|------|
| **Kody** | SDLC Pipeline | MIT | Any via LiteLLM | GitHub Actions | Yes | API costs |
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
| **Quality gates** | typecheck + tests + lint + AI diagnosis | Basic validation |
| **Risk gate** | Pauses HIGH-risk for approval | No |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Basic retry |
| **Memory** | Auto-learns conventions per project | No project memory |
| **Models** | Any via LiteLLM | GitHub models only |
| **Source** | MIT open source | Proprietary |
| **Cost** | API costs (~$0.30-8/task) | $10-39/month |

**Choose Copilot Workspace** when you want interactive pair programming with tight GitHub integration.

**Choose Kody** when you want autonomous issue-to-PR automation with quality gates, failure diagnosis, and model flexibility.

### vs Devin

| | Kody | Devin |
|---|---|---|
| **Architecture** | Structured 7-stage pipeline | Single autonomous agent |
| **Transparency** | Artifacts at every stage (task.json, plan.md, review.md) | Less transparent |
| **Self-hosted** | Yes — your infra, your keys | Cloud only |
| **Models** | Any LLM via LiteLLM | Proprietary (Devin 2.0) |
| **Concurrency** | Multiple issues in parallel (GitHub Actions) | Multiple Devins (paid) |
| **Cost** | API costs (~$0.30-8/task) | $20/mo (Core) to $500/mo (Team) |
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

## Kody's Unique Advantages

1. **Structured pipeline, not just an agent.** 7 stages with artifacts at each step. You can inspect, rerun from any stage, and understand exactly what happened.

2. **AI failure diagnosis.** When tests fail, Kody classifies the error (fixable vs infrastructure vs pre-existing) before deciding whether to retry, skip, or abort. No wasted autofix cycles on flaky tests.

3. **Risk gate.** HIGH-risk tasks pause for human approval after the plan is generated — before any code is written. No other tool does this.

4. **Self-improving memory.** Each successful run extracts coding conventions and stores them for future runs. The pipeline gets better at your specific project over time.

5. **Model agnostic.** Route through LiteLLM to use any model. Test with a cheap model, ship with a strong one. Switch providers without changing a line of code.

6. **Runs in CI.** No IDE required, no cloud VM, no subscription. Just GitHub Actions and your API key.
