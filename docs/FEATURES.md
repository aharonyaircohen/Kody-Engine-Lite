# Features

## Repo-Aware Step Files (`.kody/steps/`)

Every AI coding tool sends the same generic prompt to every repo. Kody doesn't. During `init`, Kody analyzes your codebase and generates **customized instruction files for each pipeline stage** in `.kody/steps/`.

Each step file contains the original engine prompt **plus three repo-specific sections**:

- **Repo Patterns** — real code examples extracted from your codebase with file paths, function signatures, and snippets. These show the AI what "good" looks like *in your project*, not in some generic best-practices guide.
- **Improvement Areas** — gaps, anti-patterns, and inconsistencies identified during init. When the AI touches related code during a task, it incrementally fixes these issues — raising quality organically over time.
- **Acceptance Criteria** — a concrete checklist (markdown checkboxes) that defines "done" for each stage. These criteria are grounded in your actual toolchain, conventions, and quality bar.

### Step files generated

| File | Controls |
|------|----------|
| `taskify.md` | How tasks are classified and scoped for this repo |
| `plan.md` | Planning guidelines with your repo's architecture in mind |
| `build.md` | Coding instructions with your actual patterns as examples |
| `autofix.md` | How to fix verification failures using your toolchain |
| `review.md` | Review checklist calibrated to your repo's quality bar |
| `review-fix.md` | How to address review findings in your codebase |

### Why this changes everything

1. **Code matches your patterns** — the AI produces code that looks like it belongs in your repo: same naming, same abstractions, same file organization
2. **Quality improves with every task** — improvement areas act as a persistent to-do list: every task that touches a weak area leaves it better
3. **Explicit, auditable quality bar** — acceptance criteria are version-controlled in `.kody/steps/`, not hidden in a prompt you can't see or change
4. **Fully customizable** — edit any step file to change how Kody works for your repo. No engine changes, no config flags — just markdown
5. **Re-generate on demand** — run `kody init --force` after major refactors to refresh step files from current codebase state

### Generic prompts vs repo-aware step files

```
Generic prompt:                          Repo-aware step file:
"Write clean code"                       "Follow the collection pattern in src/collections/certificates.ts:
                                          always cast relationTo with as CollectionSlug, register in payload.config.ts"

"Add error handling"                     "Use sanitizeHtml/sanitizeSql from src/security/sanitizers.ts
                                          for all user-supplied strings before persistence"

"Write tests"                            "Co-locate as *.test.ts, use Vitest, run pnpm test:int,
                                          test access control denial for every new collection"
```

## Shared Sessions

Stages in the same group share a Claude Code session via `--session-id` and `--resume`. This eliminates cold-start codebase re-exploration — the plan agent already knows what taskify discovered, the autofix agent already knows what build wrote.

| Group | Stages | Why |
|-------|--------|-----|
| **explore** | taskify → plan | Plan builds on taskify's codebase exploration |
| **build** | build → autofix → review-fix | Autofix and review-fix need implementation context |
| **review** | review (alone) | Fresh perspective on the code, no build bias |

Sessions are persisted in `status.json` so reruns resume the same conversation.

Additionally, each stage appends a structured summary to `context.md` — providing cross-session context. The review agent (fresh session) still knows what build decided because it reads context.md.

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
  → spawn autofix agent (resumes build session) with diagnosis guidance
  → retry verify (up to 2 attempts)
```

The autofix agent resumes the build session, so it already knows the codebase and what was implemented.

## Auto Fix-CI

When CI fails on a PR, Kody can automatically fix it:

```
CI fails on PR
  → workflow_run trigger fires
  → loop guard checks (max 1 attempt per 24h, skips if last commit from bot)
  → posts @kody fix-ci comment with CI run ID
  → engine fetches failed CI logs (gh run view --log-failed)
  → injects logs as feedback, re-runs pipeline from build stage
  → build agent fixes the code, verify confirms, ship pushes the fix
```

**Loop prevention:** Two guards prevent infinite fix loops:
1. Only one `@kody fix-ci` comment per PR per 24 hours
2. If the last commit was authored by `github-actions[bot]` or `kody[bot]`, the trigger is skipped

You can also trigger it manually: comment `@kody fix-ci` on any PR with failing CI checks.

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
