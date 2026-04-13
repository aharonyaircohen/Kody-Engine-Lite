---
name: kody
description: Write Kody-Engine-ready GitHub issues and interact with the Kody pipeline (trigger, monitor, verify)
version: 1.0.0
---

# Kody — GitHub Issue Writing & Pipeline Interaction

Use this skill when working in a repository that has Kody Engine installed. It has two parts:

1. **Writing issues** — so Kody understands the task correctly on the first try
2. **Pipeline interaction** — triggering, monitoring, and verifying Kody pipeline runs

---

## Part 1 — Writing Kody-Ready Issues

### What Kody reads from an issue

Kody reads the **issue body + comments** to understand the task. Specifically:

- The **issue body** becomes the primary task description (written to `.kody/tasks/<task-id>/task.md`)
- The **first 5 comments** are included as context
- The **last 10 comments** are included (for ongoing discussions)
- **Labels** are read to determine complexity and task type

### Issue body structure

Structure the issue body with these sections, in order:

```markdown
## Goal

One clear sentence describing what needs to be built or fixed.

## Context

Why this is needed — background, motivation, user story.
1–3 paragraphs. Be specific about the problem, not the solution.

## Acceptance Criteria

- [ ] Criterion 1 (observable, testable)
- [ ] Criterion 2
- [ ] Criterion 3

## Scope

**In scope:** what Kody should implement.
**Out of scope:** what Kody should skip or what another issue covers.
```

### What makes an issue Kody-friendly

| Good | Bad |
|------|-----|
| Single, well-scoped task | Multiple unrelated tasks in one issue |
| Concrete acceptance criteria | Vague goals like "improve performance" |
| Specific file/feature references | "Fix the frontend" |
| Explains *why*, not just *what* | Just describing the implementation |
| Mentions affected files/modules | No context about where to work |

### Labels Kody reads

Add these labels **before** triggering the pipeline to control behavior:

| Label | Effect |
|-------|--------|
| `kody:low` | Skip plan stage and review stage — Kody builds directly |
| `kody:medium` | Skip review-fix stage (review runs but failures are not auto-retried) |
| `kody:high` | Full pipeline including risk gate — Kody pauses for `@kody approve` before building |
| `kody:feature` | Labels the task as a feature in the PR title (`feat:` prefix) |
| `kody:bugfix` | Labels the task as a bug fix (`fix:` prefix) |
| `kody:refactor` | Labels as refactoring (`refactor:` prefix) |
| `kody:docs` | Labels as documentation (`docs:` prefix) |

> **Tip:** If you don't set a complexity label, Kody's `taskify` stage infers it from the issue scope. Set `kody:low` explicitly if you want a fast, focused build with no review overhead.

### What to avoid

- **Multi-issue issues** — split them. Kody processes one task per pipeline run.
- **Solution-first descriptions** — describe the *problem*, not the implementation. Let Kody propose the solution in its plan.
- **Missing acceptance criteria** — without them, there's no clear definition of done.
- **References to other issues** — if work depends on another issue being done first, say so explicitly in Scope.

---

## Part 2 — Triggering the Kody Pipeline

### Who can trigger Kody

Only users with these GitHub author associations can trigger Kody:
- **OWNER** — repo owner
- **MEMBER** — organization member
- **COLLABORATOR** — accepted collaborator

Bot accounts, contributors, and first-time contributors are **blocked** and receive an error comment.

### Trigger commands

Post a comment on the GitHub issue (or PR) using one of these:

```bash
@kody              # Full pipeline (taskify → plan → build → verify → review → ship)
@kody full         # Same as @kody (explicit)
@kody rerun        # Resume from the last failed stage (uses previous task-id)
@kody rerun <id>   # Resume a specific task-id from the last failed stage
@kody rerun <id> --from <stage>  # Resume from a specific stage (e.g. --from build)
@kody fix          # Fix the last failed run — diagnose and push fixes
@kody fix-ci       # Fix CI failures only (detect → fix → push without full pipeline)
@kody review       # Review the latest PR
@kody review <url> # Review a specific PR URL
@kody bootstrap    # Re-run bootstrap (analyze repo, regenerate memory files)
@kody approve      # Approve a paused pipeline (answers the risk gate for kody:high issues)
@kody ask <q>      # Ask a question — Kody posts an answer as a comment and pauses
@kody hotfix       # Hotfix mode — skip plan and review stages
@kody decompose    # Decompose this issue into sub-tasks
```

### Passing feedback to a pipeline run

Append feedback after the command — it becomes the `feedback` field:

```bash
@kody  # Full pipeline with no extra feedback
@kody --feedback "Use the new API endpoint instead of the old one"
@kody approve --feedback "Yes, go ahead with the changes"
```

---

## Part 3 — Monitoring the Pipeline

### Label lifecycle

Kody sets these labels in sequence as the pipeline progresses. Watch them to track status:

```
kody:planning  →  kody:building  →  kody:verifying  →  kody:review
→  kody:fixing  →  kody:shipping  →  kody:done (success)
                                                   ↘  kody:failed
kody:waiting   # Pipeline paused — Kody is waiting for answers to questions
kody:paused    # Pipeline paused — awaiting @kody approve (risk gate for kody:high)
```

> **In CI runs**, labels are the only persistent state between steps (`.kody/tasks/` doesn't survive across CI jobs). If a pipeline fails and is retried, Kody reads these labels to determine where to resume.

### What Kody posts as comments

Kody posts these comment types on the issue during the pipeline:

| Comment | Meaning |
|---------|---------|
| `🚀 Kody pipeline started: \`task-id\` ([logs](url))` | Pipeline triggered, logs linked |
| Questions listed in a block | Pipeline paused at question gate — answer each question in a comment |
| `🛑 **Risk gate: HIGH complexity — awaiting approval**` + plan summary | Pipeline paused at risk gate — use `@kody approve` to proceed |
| `To approve: \`@kody approve\`` | Follow-up after risk gate warning |
| `✅ Fix pushed to PR #N` | Review-fix stage pushed changes to the PR |
| `🎉 PR created: https://...` | Pipeline succeeded — PR link posted |
| `## Pipeline Summary` (table) | Stage-by-stage status, duration, and retry count |
| `❌ Pipeline failed at **stage-name**` | Pipeline failed — check the stage details |

### Reading the pipeline summary

The pipeline summary comment is a markdown table:

```markdown
## Pipeline Summary

| Stage       | Status  | Duration | Retries |
|-------------|---------|----------|---------|
| taskify     | ✅ PASS | 12s      | 0       |
| plan        | ✅ PASS | 45s      | 0       |
| build       | ✅ PASS | 3m 12s   | 0       |
| verify      | ✅ PASS | 1m 08s   | 1       |
| review      | ✅ PASS | 28s      | 0       |
| ship        | ✅ PASS | 18s      | 0       |
```

- **Status `✅ PASS`** — stage succeeded
- **Status `❌ FAIL`** — stage failed; check the error comment above the summary
- **Retries > 0** — Kody self-healed via retry; the summary shows how many attempts were needed

---

## Part 4 — Verifying Success & Triaging Failures

### Pipeline succeeded — what to check

1. **PR link** in the success comment (`🎉 PR created: ...`)
2. **Pipeline summary** — all stages show `✅ PASS`
3. **Labels** — `kody:done` + `kody:success` on the issue
4. **PR body** — should contain `Closes #<issue-number>` and a summary of changes

If the PR was created but labels aren't updated (rare CI timing issue), manually refresh by checking the PR status.

### Pipeline failed — triage path

1. **Find the failure stage** — look for `❌ Pipeline failed at **stage-name**` in the comments
2. **Check the error message** — the failure comment contains the error details
3. **Read the retry count** — if retries > 0, Kody already tried to self-heal
4. **Choose your action**:

```bash
@kody fix          # Best for: build errors, lint errors, test failures
@kody rerun --from build  # Best for: Kody pushed bad code, you fixed it locally and want to resume from build
@kody rerun --from plan   # Best for: plan was wrong or you want Kody to re-plan from scratch
@kody bootstrap    # Best for: verify stage fails due to missing tools/setup
```

### Verify stage failures

| Stage | Common failure | Fix command |
|-------|---------------|-------------|
| `taskify` | Issue body too vague | Edit the issue body with clearer acceptance criteria, then `@kody rerun --from taskify` |
| `plan` | Kody proposed wrong approach | Add guidance in a comment, then `@kody rerun --from plan` |
| `build` | Kody wrote broken code | `@kody fix` — Kody diagnoses and fixes |
| `verify` | Tests/lint/typecheck fail | `@kody fix` — Kody runs diagnosis and retries |
| `review` | Kody's own review found issues | `@kody` (standard full pipeline) — review-fix runs automatically |
| `ship` | Push/auth error | Check that the branch doesn't exist and GitHub token is valid, then `@kody rerun --from ship` |

### Question gate — Kody is waiting for you

If Kody posts a list of questions and the issue shows `kody:waiting`:

1. **Answer each question** by posting a comment with the answers
2. Kody reads the comment and resumes the pipeline automatically

> You don't need to use any special command — just post a regular comment with the answers.

### Risk gate — high complexity waiting for approval

If the issue shows `kody:high` and Kody posted the risk gate comment with a plan summary:

1. **Review the plan summary** in the comment
2. **Approve or redirect**:
   ```bash
   @kody approve                    # Approve as-is
   @kody approve --feedback "Yes, but use the v2 API instead"  # Approve with guidance
   ```
   After approval, Kody resumes from the build stage (not from scratch).

---

## Summary — Quick Reference

| Goal | Action |
|------|--------|
| Start a full pipeline | Comment `@kody` on the issue |
| Monitor progress | Watch `kody:*` labels |
| Answer questions | Post a regular comment with answers |
| Approve high-risk task | Comment `@kody approve` |
| Fix a failure | Comment `@kody fix` |
| Resume a specific task | Comment `@kody rerun <task-id> --from <stage>` |
| Create Kody-ready issue | See **Part 1** above |
