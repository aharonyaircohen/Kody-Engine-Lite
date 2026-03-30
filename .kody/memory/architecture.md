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
