# Features

## Risk Gate

When Kody detects a **HIGH-risk** task (auth, security, data migrations, database schema), it pauses after the plan stage and posts the implementation plan on the issue:

```
🛑 Risk gate: HIGH complexity — awaiting approval

📋 Plan summary
  ## Step 1: Create JWT service...
  ## Step 2: Add auth middleware...

To approve: @kody approve
```

The pipeline resumes only after `@kody approve`. This ensures security-critical code gets human oversight before a single line is written.

**When it fires:** HIGH complexity + CI mode + issue number + first run

**Bypassed for:**
- Local runs (`--local`)
- Reruns (already approved)
- Medium/low complexity tasks
- Runs without an issue number
- Dry runs

## Question Gates

Kody asks before building if something is unclear:

- **Taskify** asks product/requirements questions: "Should search be case-sensitive?"
- **Plan** asks architecture questions: "Should we use middleware or decorator pattern?"

When questions are detected:
1. Pipeline pauses
2. Questions posted as a comment on the issue
3. `kody:waiting` label applied
4. Resume with `@kody approve` + answers in the comment body

## AI-Powered Failure Diagnosis

When verify (typecheck/tests/lint) fails, Kody doesn't blindly retry. An AI observer diagnoses the error and classifies it:

| Classification | Action | Example |
|---------------|--------|---------|
| **fixable** | lintFix + formatFix + autofix agent → retry | TypeScript errors in new code |
| **infrastructure** | Skip — mark as passed | Flaky test, network timeout |
| **pre-existing** | Skip — mark as passed | Error existed before Kody's changes |
| **retry** | Retry without autofix | Transient compilation error |
| **abort** | Stop pipeline | Missing dependency, broken config |

The diagnosis includes a **reason** (what went wrong) and **resolution** (how to fix it). The resolution is injected into the autofix agent's prompt as guidance.

## Retrospective System

After each pipeline run (pass or fail), Kody analyzes what happened:

- **Observation**: what went well, what went wrong
- **Pattern match**: does this match a pattern from previous runs?
- **Suggestion**: one specific, actionable improvement
- **Pipeline flaw**: component-level issue with supporting evidence

Results are appended to `.kody/memory/observer-log.jsonl` as structured JSON. Over time, this builds institutional knowledge about recurring issues and pipeline improvements.

## Auto-Learning Memory

After each successful run, Kody extracts conventions from pipeline artifacts:

- Testing framework and patterns (vitest, jest)
- Linting rules (eslint config)
- Import conventions (path aliases, barrel exports)
- Architecture patterns

Conventions are stored in `.kody/memory/conventions.md` and prepended to every future agent prompt, improving accuracy over time.

## Lifecycle Labels

Kody updates issue labels in real-time as the pipeline progresses:

```
kody:planning → kody:building → kody:review → kody:done
```

If it fails: `kody:failed`. If waiting for human input: `kody:waiting`.

### All Labels (created by `init`)

| Category | Labels |
|----------|--------|
| **Lifecycle** | `kody:planning`, `kody:building`, `kody:review`, `kody:done`, `kody:failed`, `kody:waiting` |
| **Complexity** | `kody:low`, `kody:medium`, `kody:high` |
| **Type** | `kody:feature`, `kody:bugfix`, `kody:refactor`, `kody:docs`, `kody:chore` |

## Branch Management

- Auto-creates feature branches: `<issue-number>--<title-slug>`
- Syncs with default branch before building (merges latest)
- Handles merge conflicts gracefully (abort and warn)
- Commits after build: `feat(<task>): implement task`
- Commits after review-fix: `fix(<task>): address review`

## Verify + Autofix Loop

When verification fails:

```
verify fail
  → AI diagnosis (fixable/infrastructure/pre-existing/abort)
  → run lintFix command
  → run formatFix command
  → spawn autofix agent with diagnosis guidance
  → retry verify (up to 2 attempts)
```

The autofix agent has the diagnosis resolution injected into its prompt, so it knows exactly what to fix.

## Rich PR Descriptions

```markdown
## What
Add authentication middleware to 8 unprotected API routes

## Scope
- `src/middleware/auth.ts`
- `src/app/api/cron/route.ts`

**Type:** bugfix | **Risk:** high

## Changes
Added auth middleware to all cron routes and copilotkit endpoint.

**Review:** PASS
**Verify:** typecheck + tests + lint passed

<details><summary>Implementation plan</summary>
...
</details>

Closes #42
```
