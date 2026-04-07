# Project Memory

## architecture
# Architecture

**Kody Engine Lite** is a TypeScript ESM orchestrator for autonomous SDLC pipelines. Runs 7-stage workflows (taskify → plan → build → verify → review → review-fix → ship) triggered by GitHub comments, executing Claude Code at each stage.

## Tech Stack

- **Language**: TypeScript (strict, ES2022)
- **Runtime**: Node 22+
- **Build**: tsup → dist/
- **Testing**: Vitest
- **Execution**: Claude API (haiku/sonnet/opus) via LiteLLM proxy
- **Agent Communication**: Subprocess via stdin/stdout

## Key Modules

- **src/state-machine.ts**: Pipeline orchestrator, stage sequencing
- **src/entry.ts**: CLI entry point, task routing
- **src/agent-runner.ts**: Subprocess-based agent executor with timeout/signal management
- **src/review-standalone.ts**: Standalone review stage, multi-PR resolution
- **src/cli/litellm.ts**: LiteLLM provider routing, tier-based model mapping (cheap/mid/strong)
- **src/bin/**: CLI binary distribution
- **prompts/**: Stage templates and instructions
- **templates/kody.yml**: GitHub Actions workflow
- **.kody/tasks/**: Runtime state persistence

## Data Flow

GitHub comment (@kody full) → Workflow → CLI → State Machine → 7 Stages → PR Creation. Each stage: task.json input → spawn agent subprocess → stdin prompt → stdout results → task persistence. Provider abstraction routes models via LiteLLM (single provider or multi-provider gateway).

## Agent Execution Model

Subprocess spawning with configurable timeout (SIGTERM grace period 5s, then SIGKILL). Stdin receives serialized prompt, stdout/stderr captured. Task ID generated per run for .kody/tasks/ state directory.

## conventions
# Conventions

## Code

- **TypeScript strict mode**: Full type safety, no implicit any
- **ES2022 modules**: Top-level await, import.meta
- **Immutability**: Spread operators for state updates
- **Error handling**: Try-catch with detailed logging
- **Process lifecycle**: Spawn → writeStdin → waitForProcess → cleanup on timeout

## Execution & Configuration

- **Tier-based model routing**: cheap/mid/strong tiers map to provider models via `TIER_TO_ANTHROPIC_IDS`
- **LiteLLM config generation**: Dynamic YAML from provider + modelMap, supports provider-specific API key env vars
- **Task ID pattern**: Standardized generation via `generateTaskId()` for state persistence

## Git & Testing

- **Commits**: Conventional format (feat, fix, refactor, docs, test, chore)
- **Tests**: Vitest unit tests, aim for high coverage
- **Type checking**: Required before commit (tsc --noEmit)

## Project Organization

- **src/**: Source TypeScript (bin/, cli/, learning/, pipeline/, stages/)
- **dist/**: Published npm package
- **prompts/**: Claude instructions per stage
- **.kody/tasks/**: Task state persistence (committed to git)

Refer to ONBOARDING.md for full architecture, design decisions, and pipeline internals.


# Kody Memory System

This project uses Kody's memory at `/Users/aguy/projects/Kody-Engine-Lite/.kody/memory/`.
When the user asks you to remember something about this project, write it to the appropriate .md file there.
Follow existing file naming (e.g., architecture.md, conventions.md, patterns.md).
Check for duplicates before adding. Append new entries as bullet points under the relevant heading.
Do NOT proactively write to memory — only when the user explicitly asks to remember or save something.