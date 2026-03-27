# Pipeline

Kody runs a 7-stage pipeline that transforms a GitHub issue into a tested, reviewed pull request.

## Stages

| Stage | Tier | Default Model | Timeout | What It Does | Output |
|-------|------|--------------|---------|-------------|--------|
| **taskify** | cheap | haiku | 5 min | Classify task, detect complexity, ask questions | `task.json` |
| **plan** | strong | opus | 10 min | TDD implementation plan with deep reasoning | `plan.md` |
| **build** | mid | sonnet | 20 min | Implement code via Claude Code tools | code changes |
| **verify** | gate | — | 5 min | typecheck + tests + lint, auto-retry with diagnosis | `verify.md` |
| **review** | strong | opus | 10 min | Code review: PASS/FAIL + Critical/Major/Minor | `review.md` |
| **review-fix** | mid | sonnet | 10 min | Fix Critical and Major review findings | code changes |
| **ship** | deterministic | — | 2 min | Push branch, create PR, comment on issue | `ship.md` |

Tiers (cheap/mid/strong) are configurable via `modelMap` in `kody.config.json`. Defaults are Anthropic models. Route to any model via [LiteLLM](LITELLM.md).

### Stage Types

- **agent** — spawns Claude Code with tools (Read, Write, Edit, Bash, Grep, Glob)
- **gate** — deterministic: runs configured commands (typecheck, lint, tests)
- **deterministic** — orchestration only (git push, PR creation)

## Shared Sessions

Stages in the same **session group** share a Claude Code session — the agent remembers files it read, decisions it made, and code it explored from the previous stage. No cold-start re-exploration.

| Group | Stages | Why together |
|-------|--------|-------------|
| **explore** | taskify → plan | Both explore the codebase; plan builds on taskify's understanding |
| **build** | build → autofix → review-fix | Implementation context; autofix needs to know what build wrote |
| **review** | review (alone) | Fresh perspective — no build bias in the review |

On rerun, session IDs are loaded from `status.json` so the resumed pipeline continues the same sessions.

Additionally, each stage appends a summary to `context.md` which is injected into every stage's prompt — providing structured context even across session boundaries.

## Stage Details

### 1. Taskify

Reads the issue body, explores the codebase with tools, and outputs structured classification:

```json
{
  "task_type": "feature",
  "title": "Add retry utility with exponential backoff",
  "description": "Create a retry wrapper for async functions...",
  "scope": ["src/utils/retry.ts", "src/utils/retry.test.ts"],
  "risk_level": "low",
  "questions": []
}
```

If `questions` is non-empty, the pipeline pauses and posts them on the issue. Resume with `@kody approve`.

If the output isn't valid JSON, Kody retries once with a stricter prompt.

### 2. Plan

Creates a TDD implementation plan using deep reasoning. Resumes the same session as taskify — so it already knows the codebase. For HIGH-risk tasks, the [risk gate](FEATURES.md#risk-gate) pauses here for human approval.

### 3. Build

Spawns Claude Code in a new session. Reads the plan, existing code, and project memory, then implements the changes. Commits after completion.

### 4. Verify

Runs your configured quality commands from `kody.config.json`:

1. `quality.typecheck` (e.g., `pnpm tsc --noEmit`)
2. `quality.testUnit` (e.g., `pnpm vitest run`)
3. `quality.lint` (e.g., `pnpm lint`)

If any fail, Kody doesn't blindly retry. It [diagnoses the failure](FEATURES.md#ai-powered-failure-diagnosis), then:

1. Runs `lintFix` and `formatFix` commands
2. Spawns an autofix agent (resumes the build session) with diagnosis guidance
3. Retries verification (up to 2 attempts)

### 5. Review

AI code review in a **fresh session** (no build bias):

```markdown
## Verdict: PASS | FAIL

## Summary
<what changed and why>

## Findings
### Critical  — security, data loss, crashes
### Major    — logic errors, missing edge cases
### Minor    — style, naming, readability
```

### 6. Review-Fix

If review verdict is FAIL with Critical or Major findings, this stage fixes them — resuming the build session so it knows the implementation context. Then review reruns.

### 7. Ship

Pushes the branch and creates a PR with a rich description:

- **What** — from task.json description
- **Scope** — affected file list
- **Type/Risk** — feature/bugfix/refactor + low/medium/high
- **Changes** — from review summary
- **Verify** — typecheck/tests/lint status
- **Plan** — collapsible implementation plan
- **Closes #N** — auto-closes the issue on merge

## Complexity-Based Stage Skipping

Auto-detected from taskify's `risk_level`, or override with `--complexity`:

| Complexity | Stages Run | Stages Skipped |
|-----------|-----------|----------------|
| **low** | taskify → build → verify → ship | plan, review, review-fix |
| **medium** | taskify → plan → build → verify → review → ship | review-fix |
| **high** | all 7 stages | none |

## Task Artifacts

Each run creates artifacts in `.tasks/<task-id>/`:

```
.tasks/42-260327-102254/
├── task.md        # Issue body (input)
├── task.json      # Structured classification
├── plan.md        # Implementation plan
├── context.md     # Shared context between stages
├── verify.md      # Quality gate results
├── review.md      # Code review with verdict
├── ship.md        # PR URL and status
└── status.json    # Pipeline state (stages, sessions, retries, errors)
```

## Pipeline State

State is persisted atomically to `status.json` (write-to-tmp + rename). Each stage transition updates the state. Session IDs are stored so reruns resume the correct Claude Code sessions. A PID-based lock file prevents concurrent execution on the same task.

On rerun, completed stages are skipped. Failed/running stages are reset to pending.
