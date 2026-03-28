# Architecture

**Kody Engine Lite** is a TypeScript ESM orchestrator for autonomous SDLC pipelines. Runs 7-stage workflows (taskify → plan → build → verify → review → review-fix → ship) triggered by GitHub comments, executing Claude Code at each stage.

## Tech Stack
- **Language**: TypeScript (strict, ES2022)
- **Runtime**: Node 22+
- **Build**: tsup → dist/
- **Testing**: Vitest
- **Execution**: Claude API (haiku/sonnet/opus)

## Key Modules
- **src/state-machine.ts**: Pipeline orchestrator, stage sequencing
- **src/entry.ts**: CLI entry point, task routing
- **src/bin/**: CLI binary distribution
- **prompts/**: Stage templates and instructions
- **templates/kody.yml**: GitHub Actions workflow
- **.kody/tasks/**: Runtime state persistence

## Data Flow
GitHub comment (@kody full) → Workflow → CLI → State Machine → 7 Stages → PR Creation. Each stage reads task.json, executes Claude prompt, persists results.