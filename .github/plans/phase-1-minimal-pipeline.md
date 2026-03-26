# Phase 1 — Minimal Execution Pipeline (CLI First)

## Goal
Create a minimal working pipeline that runs a **single stage** (build) via CLI, proving the core loop: CLI → AgentRunner → Claude Code → output.

## Prerequisite
- `ANTHROPIC_API_KEY` set
- Claude Code CLI installed (`npm i -g @anthropic-ai/claude-code`)
- Node 18+, pnpm

## What gets built

### Files to create

| File | ~Lines | Purpose |
|------|--------|---------|
| `src/types.ts` | ~40 | Minimal types: `AgentRunner` interface, `AgentResult`, `AgentRunnerOptions` |
| `src/agent-runner.ts` | ~80 | Thin wrapper: spawn `claude --print`, pipe stdin, enforce timeout, return output |
| `src/entry.ts` | ~60 | CLI: `kody run --task "Create a sum function"` |
| `src/kody-utils.ts` | ~20 | `ensureTaskDir(taskId)` — create `.tasks/<id>/`, return path |
| `prompts/build.md` | ~50 | Single prompt: build stage with tool-use instructions |
| `package.json` | update | Add `pino`, `zod`; remove `openai`; script `"kody": "tsx src/entry.ts"` |

### Files to delete
`src/llm-client.ts`, `src/prompts.ts`, `src/state-machine.ts`, `src/types.ts`, `src/definitions.ts`, `src/entry.ts` (all current demo files)

## Architecture (Phase 1 only)

```
CLI (entry.ts)
  → parse --task
  → ensureTaskDir()
  → write task.md
  → create AgentRunner
  → runner.run("build", prompt, timeout, taskId, taskDir)
  → Claude Code executes (reads code, writes files, runs tests)
  → report result
```

## Implementation details

### `src/types.ts` — Minimal types
```typescript
interface AgentResult {
  outcome: "completed" | "failed" | "timed_out"
  output?: string
  error?: string
}

interface AgentRunnerOptions {
  cwd?: string
  env?: Record<string, string>
}

interface AgentRunner {
  run(stageName: string, prompt: string, model: string, timeout: number,
      taskDir: string, options?: AgentRunnerOptions): Promise<AgentResult>
  healthCheck(): Promise<boolean>
}
```

### `src/agent-runner.ts` — Thin subprocess wrapper
Per the **Agent Runner Design Principle**: spawn, pipe, timeout, return. Nothing else.

- `createClaudeCodeRunner(): AgentRunner` — factory
- `run()`:
  1. Spawn `claude --print --model sonnet --dangerously-skip-permissions --allowedTools "Bash,Edit,Read,Write,Glob,Grep"` with `stdio: ["pipe","pipe","pipe"]`
  2. Stdin: wrap `stdin.write(prompt)` in Promise, call `stdin.end()`, resolve on drain
  3. Wait for exit with timeout — SIGTERM, then SIGKILL after 5s. Collect stderr as Buffers.
  4. Return `AgentResult`: exit 0 → completed, non-0 → failed (last 500 chars stderr)
- `healthCheck()`: run `claude --version`, return true if exit 0
- Env injected: `SKIP_BUILD=1`, `SKIP_HOOKS=1`

### `src/entry.ts` — Minimal CLI
```
pnpm kody run --task "Create a TypeScript function that sums an array of numbers with tests"
```
- Parse `--task` from argv (required)
- Generate taskId from timestamp: `YYMMDD-HHMMSS`
- `ensureTaskDir(taskId)` → `.tasks/<id>/`
- Write `task.md` with task description
- Read `prompts/build.md`, append task.md content
- Call `runner.run("build", prompt, "sonnet", 1200000, taskDir)`
- Log result (completed/failed)

### `prompts/build.md` — Build prompt (tool-use)
```markdown
---
name: build
description: Implement code changes
tools: [read, write, edit, bash, glob, grep]
---

You are a code implementation agent. Read the task below and implement it.

Rules:
- Use Read to examine existing code before making changes
- Use Write/Edit to create or modify files
- Use Bash to run tests after each logical group of changes
- Do NOT commit or push — the orchestrator handles git
- Write complete, working code — not stubs or placeholders

{{TASK_CONTEXT}}
```

`{{TASK_CONTEXT}}` is replaced with the task.md content by entry.ts before passing to the runner.

## What is NOT in Phase 1
- No multi-stage pipeline (only build)
- No state persistence (no status.json)
- No resume/rerun
- No config system (hardcoded model "sonnet")
- No logger (console.log)
- No validators
- No memory system
- No GitHub integration
- No LiteLLM
- No Superpowers
- No verify/review stages

## Success criteria
Run 5 real tasks successfully:
```bash
pnpm kody run --task "Create a TypeScript function that sums an array of numbers with tests"
pnpm kody run --task "Add a fibonacci function to src/math.ts with edge case handling"
pnpm kody run --task "Create a simple HTTP server using Node.js built-in http module"
pnpm kody run --task "Refactor the entry.ts to extract argument parsing into a separate function"
pnpm kody run --task "Add input validation using zod to the CLI arguments"
```

Each should:
- Create/modify files in the working directory
- Output saved to `.tasks/<id>/`
- Exit 0 on success

## Verification
```bash
pnpm typecheck                          # Compiles
pnpm kody run --task "Add a sum fn"     # Runs end-to-end
ls .tasks/                              # Task directory created
```
