# Pipeline

Kody runs a 7-stage pipeline that transforms a GitHub issue into a tested, reviewed pull request.

## Stages

| Stage | Model Tier | Timeout | What It Does | Output |
|-------|-----------|---------|-------------|--------|
| **taskify** | cheap (haiku) | 5 min | Classify task, detect complexity, ask questions | `task.json` |
| **plan** | strong (opus) | 10 min | TDD implementation plan with deep reasoning | `plan.md` |
| **build** | mid (sonnet) | 20 min | Implement code via Claude Code tools | code changes |
| **verify** | gate | 5 min | typecheck + tests + lint, auto-retry with diagnosis | `verify.md` |
| **review** | strong (opus) | 10 min | Code review: PASS/FAIL + Critical/Major/Minor | `review.md` |
| **review-fix** | mid (sonnet) | 10 min | Fix Critical and Major review findings | code changes |
| **ship** | deterministic | 2 min | Push branch, create PR, comment on issue | `ship.md` |

### Stage Types

- **agent** — spawns Claude Code with tools (Read, Write, Edit, Bash, Grep, Glob)
- **gate** — deterministic: runs configured commands (typecheck, lint, tests)
- **deterministic** — orchestration only (git push, PR creation)

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

Creates a TDD implementation plan using deep reasoning. For HIGH-risk tasks, the [risk gate](FEATURES.md#risk-gate) pauses here for human approval.

### 3. Build

Spawns Claude Code with full tool access. The agent reads the plan, existing code, and project memory, then implements the changes. Commits after completion.

### 4. Verify

Runs your configured quality commands from `kody.config.json`:

1. `quality.typecheck` (e.g., `pnpm tsc --noEmit`)
2. `quality.testUnit` (e.g., `pnpm vitest run`)
3. `quality.lint` (e.g., `pnpm lint`)

If any fail, Kody doesn't blindly retry. It [diagnoses the failure](FEATURES.md#ai-powered-failure-diagnosis), then:

1. Runs `lintFix` and `formatFix` commands
2. Spawns an autofix agent with diagnosis guidance
3. Retries verification (up to 2 attempts)

### 5. Review

AI code review with structured output:

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

If review verdict is FAIL with Critical or Major findings, this stage fixes them. Then review reruns.

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
├── verify.md      # Quality gate results
├── review.md      # Code review with verdict
├── ship.md        # PR URL and status
└── status.json    # Pipeline state (stages, retries, errors, timestamps)
```

## Pipeline State

State is persisted atomically to `status.json` (write-to-tmp + rename). Each stage transition updates the state. A PID-based lock file prevents concurrent execution on the same task.

On rerun, completed stages are skipped. Failed/running stages are reset to pending.
