# Tech Stack

> The technologies Kody is built on, how they layer together, and what each unlocks.

## Architecture

```
GitHub / CLI                 ← Trigger layer
     ↓
Kody Engine                  ← Thin infra (config, state, git, GitHub API)
     ↓
Pipeline Orchestrator        ← 7-stage SDLC with quality gates
     ↓
Claude Code                  ← Execution agent (read, write, edit, run)
     ↓
Superpowers                  ← Execution discipline (TDD, planning, review)
     ↓
LiteLLM                     ← Model routing (optional)
     ↓
LLMs                         ← Anthropic, MiniMax, Gemini, etc.
```

## Layer by Layer

| Layer | What | Why It Matters |
|-------|------|----------------|
| **GitHub / CLI** | GitHub Actions (comment-triggered) or local CLI | Same engine runs in CI and on your machine. `@kody` on an issue is all it takes. |
| **Kody Engine** | Config, state persistence, git/GitHub operations | Deliberately thin — no framework, no SDK deps. Manages branches, PRs, labels, and task state. The orchestrator is dumb by design; intelligence lives in the layers below. |
| **Pipeline Orchestrator** | 7 stages: taskify → plan → build → verify → review → review-fix → ship | Structured SDLC, not a single conversation. Quality gates between every stage. Complexity-aware — low tasks skip expensive stages. |
| **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** | AI agent with native file/shell tools | Reads, writes, edits, and runs commands in your repo. Persistent sessions carry context across stages. Extensible via [MCP servers](https://modelcontextprotocol.io/) for browser automation and custom tools. |
| **[Superpowers](https://github.com/obra/superpowers)** | Execution discipline framework by Jesse Vincent | The reason Claude Code doesn't freewheel. Enforces brainstorming before planning, TDD (red-green-refactor), step-by-step plan execution with verification, structured review with severity levels, and subagent isolation. LLM capability isn't the bottleneck — process discipline is. Superpowers carries that discipline so Kody can stay thin. |
| **[LiteLLM](https://docs.litellm.ai/)** | Universal proxy for Anthropic-compatible providers | Swap models without code changes. Three tiers (cheap/mid/strong) per stage. Optional — direct Anthropic works out of the box. |
| **LLMs** | Anthropic Claude, MiniMax, Gemini, and others | Your choice. Route taskify through a fast model, plan through a deep reasoning one, build through a balanced one. |

## Differentiators

What this stack enables that single-agent tools don't.

| Capability | How |
|-----------|-----|
| **Structured pipeline** | 7 stages with quality gates — not a single conversation that drifts |
| **Warm sessions** | Grouped Claude Code sessions share context (plan inherits from taskify, review-fix inherits from build) |
| **Repo-aware prompts** | `bootstrap` generates per-stage instructions from your actual codebase — patterns, gaps, acceptance criteria |
| **AI failure diagnosis** | 5-way classification (fixable / infrastructure / pre-existing / retry / abort) before deciding to fix, skip, or stop |
| **Self-improving memory** | Auto-learns conventions, remembers architectural decisions, detects recurring patterns across runs |
| **Human-in-the-loop** | Risk gate pauses for approval, question gates ask before guessing, rerun accepts feedback |
| **Model flexibility** | Three tiers (cheap/mid/strong) per stage — route taskify through a fast model, plan through a deep one |

---

[Pipeline details →](PIPELINE.md) · [Features →](FEATURES.md) · [Configuration →](CONFIGURATION.md) · [LiteLLM setup →](LITELLM.md)
