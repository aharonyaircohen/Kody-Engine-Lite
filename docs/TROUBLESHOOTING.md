# Troubleshooting Guide

When Kody's pipeline fails, this guide helps you understand what went wrong and how to fix it.

## Reading Pipeline State (`status.json`)

Every pipeline run generates a `status.json` file in `.kody/tasks/<task-id>/` that tracks the state of all 7 stages.

### What's in `status.json`?

```json
{
  "taskId": "3-260401-160322",
  "state": "failed",
  "stages": {
    "taskify": { "state": "completed", "retries": 0, "completedAt": "2026-04-01T16:03:50Z" },
    "plan": { "state": "completed", "retries": 0, "completedAt": "2026-04-01T16:04:30Z" },
    "build": { "state": "failed", "retries": 2, "error": "typecheck failed", "completedAt": "2026-04-01T16:05:15Z" },
    "verify": { "state": "pending", "retries": 0 },
    "review": { "state": "pending", "retries": 0 },
    "review-fix": { "state": "pending", "retries": 0 },
    "ship": { "state": "pending", "retries": 0 }
  },
  "createdAt": "2026-04-01T16:03:22Z",
  "updatedAt": "2026-04-01T16:05:15Z"
}
```

### Key Fields

- **taskId**: Unique identifier for this pipeline run. Artifacts are stored in `.kody/tasks/<task-id>/`
- **state**: Overall pipeline status
  - `running` — pipeline is still executing
  - `completed` — pipeline finished successfully (PR created and issue closed)
  - `failed` — pipeline stopped at a failed stage
- **stages**: Dictionary of all 7 stages, each with:
  - **state**: `pending` (not started), `completed` (success), `failed` (error), `paused` (waiting for approval)
  - **retries**: Number of times this stage retried (before giving up or moving forward)
  - **error**: Brief error message if state is `failed`
  - **completedAt**: ISO 8601 timestamp when stage finished
  - **outputFile**: Path to detailed output (e.g., `.kody/tasks/<task-id>/plan.md`)

### How to Find the Failing Stage

1. Open `.kody/tasks/<task-id>/status.json` in your editor
2. Look for the first stage with `"state": "failed"`
3. Check its `error` field for a brief reason
4. Read the corresponding stage file for full details:
   - Build failed? → `.kody/tasks/<task-id>/verify.md` (contains typecheck/test/lint output)
   - Review failed? → `.kody/tasks/<task-id>/review.md`
   - Other stages → `.kody/tasks/<task-id>/<stage-name>.md`

**Example:**
```json
"verify": { "state": "failed", "error": "tests failed after 1 retry", "completedAt": "2026-04-01T16:05:15Z" }
```
→ Read `.kody/tasks/<task-id>/verify.md` to see which tests failed and why.

## Diagnosis Classifications

When a stage fails, Kody's diagnosis agent classifies the error into one of 5 categories. These determine whether to retry, fix, skip, or abort. You'll see the classification in the failure comment Kody posts on your issue.

### **fixable** — Code Error (Kody Can Fix)

The error is in code that Kody just wrote or modified. Kody will automatically enter the `review-fix` stage to fix it.

**Examples:**
- TypeScript compilation error (missing import, type mismatch)
- Test failure in a file Kody modified
- Lint rule violation in new code

**What to do:**
- Wait for `review-fix` stage to run and push the fix
- If it fails again, read the error and decide if you want to provide manual feedback with `@kody fix`

### **infrastructure** — External Dependency Missing

The error is due to something external that Kody can't fix: missing API key, database unavailable, service not configured.

**Examples:**
- `ANTHROPIC_API_KEY` not set
- Database connection failed
- Third-party service (Stripe, Auth0) misconfigured
- Docker or system tool not installed

**What to do:**
1. Identify the missing dependency from the error message
2. Set it up (add secret, configure service, install tool)
3. Run `@kody rerun` to retry from the failed stage

### **pre-existing** — Code Not Changed by Kody

The error exists in code that Kody didn't touch. Safe to skip because Kody's changes aren't the cause.

**Examples:**
- A test failing in a file Kody didn't modify
- TypeScript error in pre-existing code
- Flaky test that was already intermittently failing

**What to do:**
1. Fix the pre-existing issue in your codebase (separate PR)
2. Then run `@kody rerun` or start fresh with `@kody` — Kody won't touch the pre-existing error
3. **Tip:** If pre-existing tests are flaky, consider skipping them temporarily while Kody works, then fix them afterward

### **retry** — Transient Error (Probably Recoverable)

A temporary network issue, rate limit, or flaky test. Worth trying again.

**Examples:**
- Network timeout calling the LLM API
- Rate limit from CI runner (too many processes)
- Flaky test that passes on second run

**What to do:**
- Run `@kody rerun` — it will retry from the failed stage
- If it fails multiple times with the same error, check logs and consider if it's actually `fixable`, `infrastructure`, or `pre-existing`

### **abort** — Unrecoverable Error (Stop Pipeline)

A critical problem that the pipeline can't recover from. Pipeline stops immediately.

**Examples:**
- Permission denied (can't write files)
- Disk full
- Corrupted git state (merge conflict that can't be resolved)
- Process killed unexpectedly

**What to do:**
1. Fix the underlying issue (clear disk, resolve merge conflict, check permissions)
2. Manual cleanup may be needed:
   - If a feature branch is stuck, run: `git checkout main && git branch -D kody-<issue-id>` (optional cleanup)
   - Check GitHub Actions logs for the full error message
3. Run `@kody rerun` or start fresh with `@kody`

## Common Errors

### "Model name rejected" / Exit code 1 (LiteLLM)

**What it means:** Claude Code rejected the model name. Usually happens when using a non-Anthropic provider.

**Check:**
```bash
# Verify your kody.config.json uses Anthropic model names
cat kody.config.json
```

You should see:
```json
{
  "agent": {
    "provider": "minimax",
    "modelMap": {
      "cheap": "haiku",       // ✓ Correct — Anthropic name
      "mid": "sonnet",
      "strong": "opus"
    }
  }
}
```

NOT:
```json
{ "modelMap": { "cheap": "minimax-test" } }  // ✗ Wrong — custom name
```

**Fix:**
- Use Anthropic model names (`haiku`, `sonnet`, `opus`) in `modelMap`
- LiteLLM will internally map them to your provider (MiniMax, Gemini, etc.)
- See [LiteLLM guide](LITELLM.md#setup) for details

### "litellm not installed" / Proxy won't start

**What it means:** LiteLLM is required for non-Anthropic providers, but it's not installed or not on PATH.

**Check:**
```bash
# Local development
which litellm
litellm --version

# CI: Check your workflow has the venv + symlink pattern
cat .github/workflows/kody.yml | grep -A 3 "Install LiteLLM"
```

**Fix:**

**Local:**
```bash
pip install 'litellm[proxy]'
# Or via venv (recommended for CI)
python3 -m venv /tmp/litellm-venv
/tmp/litellm-venv/bin/pip install 'litellm[proxy]'
```

**In CI workflow (.github/workflows/kody.yml):**
```yaml
- name: Install LiteLLM proxy
  run: |
    python3 -m venv /tmp/litellm-venv
    /tmp/litellm-venv/bin/pip install 'litellm[proxy]'
    sudo ln -sf /tmp/litellm-venv/bin/litellm /usr/local/bin/litellm
```

Then run `@kody rerun` to retry.

### Verify keeps failing / Too many retries

**What it means:** The `verify` stage (typecheck, tests, lint) is failing after multiple auto-fix retries.

**Check the output:**
```bash
# Find your task directory
ls .kody/tasks/

# Read the full verify output
cat .kody/tasks/<task-id>/verify.md
```

**This usually means:**

1. **fixable code errors** — Kody wrote code that doesn't pass your quality gates. See if the error message is clear; if so, provide feedback with `@kody fix "specific feedback"` to guide the next attempt.

2. **pre-existing test failures** — Tests that were already failing are still broken. Not Kody's fault. Fix them separately, then `@kody rerun`.

3. **flaky tests** — Some tests pass sometimes and fail sometimes. Run `@kody rerun` again; it might pass next time.

4. **too-strict gates** — Your `kody.config.json` runs commands that are overly strict (e.g., `pnpm test:strict` that fails on warnings). Consider running the same tests locally and adjusting the command.

**What to do:**
```bash
# Run the exact verify command locally to understand the failure
# (from your kody.config.json)
pnpm typecheck
pnpm test
pnpm lint

# Then either:
# 1. Fix the code and commit manually, then run @kody rerun (Kody will verify it)
# 2. Provide feedback: @kody fix "Use [pattern] instead of [old pattern]"
# 3. Skip to next stage: @kody rerun --from review (if you're confident the code is fine)
```

### Risk gate paused (HIGH-risk task)

**What it means:** Kody classified the task as HIGH-risk and is waiting for your approval before writing code.

**Check the plan:**
1. Find the comment Kody posted on the issue titled "HIGH-RISK Task — Waiting for Approval"
2. Read the plan (in `.kody/tasks/<task-id>/plan.md`)

**What to do:**

- **Approve it:** `@kody approve` — Kody resumes from plan to build stage
- **Reject it:** Don't comment `@kody approve`. Close the issue or comment with feedback to start over
- **Modify it:** Comment `@kody fix "refocus on X instead of Y"` to provide feedback and replan

### "Authorization failed" / Permission denied in GitHub Actions

**What it means:** The GitHub Actions token doesn't have permission to create/push branches or review PRs.

**Check:**
1. **Repository settings** → **Actions** → **General**
2. Verify **"Allow GitHub Actions to create and approve pull requests"** is toggled ✓

**Fix:**
```bash
# Via GitHub web UI:
# Settings → Actions → General → toggle the checkbox

# Or via CLI (must have repo admin access):
# gh api repos/<owner>/<repo> --input - <<< '{"actions_default_workflow_permissions":"write"}'
```

Then run `@kody rerun`.

### "Timeout" (pipeline took too long)

**What it means:** A stage exceeded its time limit (plan/review have 10-minute limits, others have 5 minutes).

**Causes:**
- **LiteLLM proxy is slow** — Non-Anthropic providers may have higher latency
- **Task is complex** — Large codebases or deep reasoning takes longer
- **CI runner is overloaded** — Too many jobs running simultaneously

**Check:**
- Look at issue labels. If stuck on `kody:planning` or `kody:review`, the LLM stage timed out
- Check GitHub Actions logs: search for "Timeout" or the stage name

**What to do:**
```bash
# 1. Simplify the task (smaller scope) and restart:
@kody

# 2. Or skip expensive stages (LOW complexity skips plan/review):
@kody rerun --from build  # Skip to build if plan timed out

# 3. Or switch to faster models:
# In kody.config.json:
# "modelMap": { "mid": "haiku", "strong": "sonnet" }
# Then run @kody rerun
```

## When to `@kody rerun` vs `@kody` vs `@kody rerun --from <stage>`

### **`@kody` (Full Restart)**

Start a completely new pipeline run with a fresh task ID.

**Use when:**
- You made significant changes to the codebase (new files, refactored structure)
- You want to run the entire pipeline fresh (taskify → ship)
- The previous run is old and you want a clean slate

**Example:**
```
@kody
```

### **`@kody rerun` (Resume from Failed Stage)**

Resume the last pipeline run from the stage that failed.

**Use when:**
- Pipeline failed at verify or build → you want to retry without re-planning
- You fixed the infrastructure issue (missing secret, service now running)
- You want to retry a flaky test or transient error
- Kody is paused at the risk gate or question gate

**Example:**
```
# Pipeline failed at verify, you fixed the test failure locally:
@kody rerun

# Kody resumes from verify, skips taskify/plan/build
```

**What it preserves:**
- Task ID (artifacts go in the same `.kody/tasks/<task-id>/`)
- Plan and previous decisions
- Session IDs (context.md carries over)

### **`@kody rerun --from <stage>` (Resume from Specific Stage)**

Resume the last pipeline run, but skip to a specific stage (ignoring earlier stages).

**Use when:**
- Plan is correct but build has a fixable error → `@kody rerun --from build`
- Build passed but verify is too strict → `@kody rerun --from review` (skip verify)
- You want to jump to review after fixing code locally

**Example:**
```
# Build + verify both failed. You fixed the code locally and want to review it:
@kody rerun --from review

# Kody skips taskify/plan/build/verify, goes straight to review
```

**Valid stages:** `taskify`, `plan`, `build`, `verify`, `review`, `review-fix`, `ship`

### **`@kody fix "<feedback>"` (Rebuild + Review)**

Resume from the build stage with your feedback.

**Use when:**
- Build succeeded but verify failed and you have specific guidance
- Review found issues and you want to iterate
- You want to incorporate human feedback into the next attempt

**Example:**
```
# Verify failed, you know the issue:
@kody fix "Use middleware pattern instead of direct imports"

# Kody rebuilds with your feedback, re-verifies, and re-reviews
```

## CI-Specific Issues

### Workflow Not Triggering

**Check:**
1. Is `.github/workflows/kody.yml` present?
2. Did you comment `@kody` on an **issue** (not a PR)?
3. Are you a **collaborator/owner** (not external contributor)?
4. Are you using the exact syntax: `@kody` (with no typos)?

**Fix:**
```bash
# Verify the workflow exists
cat .github/workflows/kody.yml | grep "^name:"

# If missing, run init:
npx @kody-ade/kody-engine-lite init

# Or copy the template manually:
cp templates/kody.yml .github/workflows/kody.yml
git add .github/workflows/kody.yml
git commit -m "chore: add kody workflow"
git push
```

Then comment `@kody` on an issue again.

### Secrets Not Available to Workflow

**Check:**
```bash
# Verify ANTHROPIC_API_KEY is set
gh secret list --repo <owner>/<repo> | grep ANTHROPIC

# If using LiteLLM, also check:
gh secret list --repo <owner>/<repo> | grep ANTHROPIC_COMPATIBLE
```

**Fix:**
```bash
# Add or update the secret
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
# Paste your API key when prompted

# For non-Anthropic providers:
gh secret set ANTHROPIC_COMPATIBLE_API_KEY --repo <owner>/<repo>
```

### "Actions Cannot Create PRs" / Review Fails Silently

**Check:**
1. **Settings** → **Actions** → **General**
2. Verify **"Allow GitHub Actions to create and approve pull requests"** is checked ✓

**If it's checked but reviews still fail:**
- The `GITHUB_TOKEN` permissions in `.github/workflows/kody.yml` may be too restrictive
- Ensure the workflow has `pull-requests: write` permission:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

## Artifact Inspection

All pipeline artifacts are stored in `.kody/tasks/<task-id>/`:

| File | Contains |
|------|----------|
| `status.json` | Pipeline state (stages, retries, timestamps) — start here |
| `task.json` | Original issue/task description and metadata |
| `plan.md` | Execution plan (HIGH-risk tasks stop here) |
| `context.md` | Decisions and context carried between stages |
| `verify.md` | Typecheck/test/lint output |
| `review.md` | Code review findings (Critical/Major/Minor) |
| `ship.md` | Shipping status (branch name, PR URL) |

**How to read them:**
```bash
# Find the failing task
ls -lt .kody/tasks/ | head -1

# Check status
cat .kody/tasks/<task-id>/status.json | jq .

# Read the problem
cat .kody/tasks/<task-id>/verify.md

# See the plan
cat .kody/tasks/<task-id>/plan.md
```

## Getting More Help

- **Unsure about a decision?** Comment `@kody fix` with your question — Kody can iterate on requirements
- **LiteLLM-specific issues?** See [LiteLLM guide](LITELLM.md)
- **Local CLI issues?** See [CLI reference](CLI.md)
- **General questions?** Check [FAQ](FAQ.md)
