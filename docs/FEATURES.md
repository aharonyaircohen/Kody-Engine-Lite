# Features

> For a high-level overview with comparison, see [About](ABOUT.md). This page goes deeper with code examples and implementation details.

## Repo-Aware Step Files (`.kody/steps/`)

Every AI coding tool sends the same generic prompt to every repo. The result: code that *compiles* but doesn't fit your project — wrong patterns, wrong abstractions, new solutions where existing ones already work. You spend time fixing style and structure instead of reviewing logic.

Kody solves this. During `bootstrap`, it analyzes your codebase with an LLM and generates **customized instruction files for each pipeline stage** in `.kody/steps/`.

Each step file contains the original engine prompt **plus three repo-specific sections**:

- **Repo Patterns** — real code examples extracted from your codebase with file paths, function signatures, and snippets. Instead of a generic "use dependency injection," the build agent gets: "Look at `src/services/PaymentService.ts` — this is how we structure services. Follow the same pattern."
- **Improvement Areas** — gaps, anti-patterns, and inconsistencies identified during bootstrap. When the AI touches related code during a task, it incrementally fixes these issues — raising quality organically over time.
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
5. **Re-generate on demand** — run `kody-engine-lite bootstrap --force` after major refactors to refresh step files from current codebase state

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

When verify (typecheck/tests/lint) fails, Kody doesn't blindly retry. An AI diagnosis system analyzes the error and classifies it:

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

Results are appended to `.kody/memory/observer-log.jsonl` as structured JSON. Over time, this builds a searchable log of recurring patterns — use it to debug repeated failures, discover systemic issues, or tune the pipeline. Quick check after any run: `cat .kody/memory/observer-log.jsonl | jq '.suggestion'`.

## Auto-Learning Memory

After each successful run, Kody extracts conventions from pipeline artifacts:

- Testing framework and patterns (vitest, jest)
- Linting rules (eslint config)
- Import conventions (path aliases, barrel exports)
- Architecture patterns

Conventions are stored in `.kody/memory/conventions.md` and prepended to every future agent prompt, improving accuracy over time.

## Pattern Discovery

The plan stage enforces **mandatory pattern discovery**: before proposing any implementation, the agent searches for how the same problem is already solved in your codebase. If your repo already uses per-locale documents for translations, the agent won't invent new `label_en`/`label_he` fields — it'll follow the existing pattern.

Before writing a plan, the agent must:

1. **Search for similar implementations** — grep/glob for existing solutions in the codebase
2. **Reuse existing patterns** — follow the pattern if one exists
3. **Check decisions.md** — read prior architectural decisions that may apply
4. **Report findings** — every plan includes an "Existing Patterns Found" section documenting which patterns were discovered and how they're reused

## Decision Memory

Architectural decisions are automatically extracted from code reviews and saved to `.kody/memory/decisions.md`. The system detects patterns like:

- "Use existing X" / "follow existing X" / "reuse X pattern"
- "Instead of X, use Y" / "prefer Y over X"
- "Consistent with X" / "same pattern as X"
- "Don't use X for Y" / "avoid X"

Decisions are deduplicated and persist across tasks. The plan agent reads `decisions.md` before every plan, ensuring the same mistake isn't repeated.

## PR Feedback for Fix

When `@kody fix` runs on a PR, it automatically collects three layers of context:

1. **Kody's own review** — the latest "Kody Review" comment (from the review stage)
2. **Human PR comments** — issue comments and inline code review comments from human reviewers
3. **Fix comment body** — any additional text written after `@kody fix`

Human feedback is **scoped to the current fix cycle** — only comments posted after the last Kody action are included. This keeps the feedback loop clean across multiple iterations: if you fix a review comment, run `@kody fix` again, and the reviewer posts new feedback — Kody ignores the old comment you already addressed and only acts on the new one.

## Lifecycle Labels

Kody updates issue labels in real-time as the pipeline progresses:

```
kody:planning → kody:building → kody:review → kody:done
```

If it fails: `kody:failed`. If waiting for human input: `kody:waiting`.

### All Labels (created by `bootstrap`)

| Category | Labels |
|----------|--------|
| **Lifecycle** | `kody:planning`, `kody:building`, `kody:review`, `kody:done`, `kody:failed`, `kody:waiting` |
| **Complexity** | `kody:low`, `kody:medium`, `kody:high` |
| **Type** | `kody:feature`, `kody:bugfix`, `kody:refactor`, `kody:docs`, `kody:chore` |

## Branch Management

- Auto-creates feature branches: `<issue-number>--<title-slug>`
- Syncs with default branch before building (merges latest). For PR-based commands (`fix`, `fix-ci`, `rerun`), syncs against the PR's actual base branch instead of the configured default
- Handles merge conflicts gracefully (abort and warn)
- Commits after build: `feat(<task>): implement task`
- Commits after review-fix: `fix(<task>): address review`
- On rerun, if push is rejected (non-fast-forward), retries with `--force-with-lease` to safely overwrite diverged history

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

The diagnosis agent receives up to 5000 characters of error output (and the agent runner captures up to 2000 characters of stderr) to ensure accurate failure classification even for complex TypeScript or ESLint errors.

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

## Merge Conflict Resolution

Comment `@kody resolve` on any PR to merge the default branch and AI-resolve any conflicts.

**How it works:**

```
@kody resolve on PR
  → merge default branch into PR branch
  → if clean merge: push and done
  → if conflicts: identify conflicted files
  → agent reads conflict markers and diffs
  → resolves each file (preserving PR intent for features, preferring default for infra)
  → runs quality gates (typecheck, tests, lint)
  → commits + pushes resolution
  → posts summary comment on PR
```

**Resolution strategy:**
- **Feature/business logic** — preserves the PR branch's intent
- **Infrastructure/config/dependencies** — prefers the default branch
- **Imports/types** — merges both sides

The agent uses the `mid` tier model and has a 5-minute timeout. Up to 10 conflicted files are included in the context with up to 3000 chars of diff each.

**CLI usage:**
```bash
kody-engine-lite resolve --pr-number 42
```

## Standalone PR Review

Comment `@kody review` on any PR — not just PRs that Kody created — to get a structured code review.

**What it does:**
1. Reads the PR diff against the base branch (`git diff origin/<base>...HEAD`) to focus on actual PR changes, not working tree noise
2. Runs the same review methodology as pipeline stage 5 (Critical/Major/Minor findings with a PASS/FAIL verdict)
3. Submits a GitHub PR review: **approve** if PASS, **request-changes** if FAIL
4. If the PR review fails (e.g., self-review not allowed), falls back to posting a plain PR comment

**If the review finds issues:**
The comment includes a prompt to run `@kody fix`, which automatically ingests the review findings as context and fixes them.

**CLI usage:**
```bash
kody-engine-lite review --pr-number 42
kody-engine-lite review --issue-number 42  # finds the associated PR
```

**Multi-PR resolution:** If an issue has multiple open PRs, Kody lists them and asks you to specify which one. If there's only one, it reviews automatically.

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
