# Comparison with Other Tools

## Overview

| Tool | Type | Open Source | Model Flexible | CI Native | Fire & Forget | Cost |
|------|------|-------------|---------------|-----------|--------------|------|
| **Kody** | SDLC Pipeline | MIT | Anthropic-compatible via LiteLLM | GitHub Actions | Yes | API costs (free-tier models available) |
| Copilot Workspace | Interactive | No | GitHub models | GitHub Cloud | No | $10-39/mo |
| Devin | Autonomous Agent | No | Proprietary | Cloud | Partially | $20-500/mo |
| Cursor Agent | IDE Agent | No | Cursor models | No | No | Subscription |
| Cline | VS Code Extension | Yes | Any LLM | No | No | API costs |
| OpenHands | Autonomous Agent | Apache 2.0 | Any LLM | Docker | Partially | API costs |
| SWE-agent | Research Agent | MIT | Any LLM | Basic | Yes | API costs |

## Detailed Comparisons

<details>
<summary><strong>vs GitHub Copilot Workspace</strong> — interactive pair programming vs autonomous pipeline</summary>

| Category | Kody | Copilot Workspace |
|----------|------|-------------------|
| **Type** | Autonomous pipeline | Interactive assistant |
| **Trigger** | `@kody` on any issue | Open workspace from issue |
| **Runs where** | GitHub Actions (CI) | GitHub Cloud |
| **Autonomous** | Yes — fire and forget | No — requires guidance |
| **Pipeline stages** | 7 with quality gates | Plan + implement |
| **Quality gates** | Configured quality commands + AI diagnosis | Basic validation |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Basic retry |
| **Repo-aware prompts** | Yes — auto-generated per stage | No |
| **Project memory** | Yes — auto-learns conventions | No |
| **Model flexible** | Anthropic-compatible via LiteLLM | GitHub models only |
| **Open source** | MIT | Proprietary |
| **Cost** | API costs (free-tier models available) | $10-39/month |

> **Choose Copilot Workspace** if your team prefers real-time IDE-style assistance and doesn't mind the monthly cost.
> **Choose Kody** if you want to comment on an issue, walk away, and get back a tested PR — no IDE required.

</details>

<details>
<summary><strong>vs Devin</strong> — managed cloud agent vs self-hosted pipeline</summary>

| Category | Kody | Devin |
|----------|------|-------|
| **Type** | Structured pipeline | Autonomous agent |
| **Architecture** | 7 stages with artifacts | Single agent |
| **Transparency** | Full — artifacts at every stage | Limited |
| **Self-hosted** | Yes — your infra, your keys | No — cloud only |
| **Quality gates** | Configured quality commands + AI diagnosis | No structured gates |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Basic retry |
| **Repo-aware prompts** | Yes — auto-generated per stage | No |
| **Checkpoints** | Rerun from any stage | No |
| **Model flexible** | Anthropic-compatible via LiteLLM | Proprietary only |
| **Open source** | MIT | Proprietary |
| **Cost** | API costs (free-tier models available) | $20-500/month |

> **Choose Devin** if you want a fully managed cloud environment and don't need to self-host or control model choice.
> **Choose Kody** if you want full transparency (artifacts at every stage), self-hosting, and zero vendor lock-in.

</details>

<details>
<summary><strong>vs Cursor Agent / Cline</strong> — IDE agents vs CI pipeline</summary>

| Category | Kody | Cursor Agent | Cline |
|----------|------|-------------|-------|
| **Type** | Autonomous pipeline | IDE agent | IDE agent |
| **Runs where** | GitHub Actions (CI) | Local IDE | Local IDE |
| **Requires IDE open** | No | Yes | Yes |
| **Autonomous** | Yes — fire and forget | Partially | Partially |
| **Quality gates** | Configured quality commands + AI diagnosis | No | No |
| **Failure handling** | 5-way AI diagnosis + autofix | No | No |
| **Repo-aware prompts** | Yes — auto-generated per stage | No | No |
| **GitHub integration** | Native (issue → PR) | Manual | Manual |
| **Batch processing** | Multiple issues in parallel | One at a time | One at a time |
| **Model flexible** | Anthropic-compatible via LiteLLM | Cursor models | Any LLM |
| **Open source** | MIT | Proprietary | Yes |
| **Cost** | API costs (free-tier models available) | Subscription | API costs |

> **Choose Cursor/Cline** if you want AI assistance while actively coding in your IDE.
> **Choose Kody** if you want to delegate entire tasks and walk away — runs in CI, no IDE required.

</details>

<details>
<summary><strong>vs OpenHands</strong> — general-purpose agent vs structured SDLC</summary>

| Category | Kody | OpenHands |
|----------|------|-----------|
| **Type** | SDLC pipeline | Autonomous coding agent |
| **Runs where** | GitHub Actions (zero infra) | Docker/Kubernetes sandbox |
| **Setup** | `npm install` + `init` (2 min) | Docker compose + sandbox config |
| **Quality gates** | Configured quality commands + AI diagnosis | No structured gates |
| **Failure handling** | 5-way AI diagnosis + targeted autofix | Retry within agent loop |
| **Repo-aware prompts** | Yes — auto-generated per stage | No |
| **Checkpoints** | Rerun from any stage | Start over on failure |
| **Review** | Dedicated stage with fresh session | Self-review in same context |
| **Open source** | MIT | Apache 2.0 |
| **Community** | Early stage | 65K+ stars |
| **Cost** | API costs (free-tier models available) | API costs + infra |

> **Choose OpenHands** if you need general-purpose autonomous coding with a web IDE and broad tooling ecosystem.
> **Choose Kody** if you want structured issue-to-PR automation that runs in GitHub Actions with zero infrastructure setup.

</details>

<details>
<summary><strong>vs SWE-agent</strong> — research agent vs production pipeline</summary>

| Category | Kody | SWE-agent |
|----------|------|-----------|
| **Type** | Production SDLC pipeline | Research agent |
| **Focus** | Issue → PR automation | Benchmarking |
| **Quality gates** | Configured quality commands + AI diagnosis | Test execution only |
| **Failure handling** | 5-way AI diagnosis + autofix | Basic retry |
| **Repo-aware prompts** | Yes — auto-generated per stage | No |
| **Project memory** | Yes — auto-learns conventions | No |
| **GitHub integration** | Native (issues, PRs, labels, comments) | Basic |
| **Open source** | MIT | MIT |
| **Community** | Early stage | Academic (NeurIPS 2024) |

> **Choose SWE-agent** if you're doing academic research or benchmarking.
> **Choose Kody** if you need production-ready issue-to-PR automation with quality gates.

</details>

---

## Why Pipelines Beat Single Agents on Complex Tasks

| Problem | Single Agent | Kody Pipeline |
|---------|-------------|---------------|
| **Context management** | One long conversation that bloats over time | Shared sessions within groups + context.md across groups |
| **Error cascading** | Writes broken code, tries to fix in same context | Quality gate catches errors between stages, AI diagnoses before retry |
| **No checkpoint** | Fails midway → start over | Rerun from any stage — keep what worked |
| **No oversight** | Fully autonomous or needs constant approval | Risk gate pauses only HIGH-risk tasks at plan stage |
| **Review quality** | Self-review in same context (bias) | Fresh session for review — clean perspective |

See [Real-World Example](ABOUT.md#real-world-example) — a full auth system built autonomously with MiniMax via LiteLLM, all 7 stages, 3 autofix retries, zero human intervention.
