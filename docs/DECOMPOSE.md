# Parallel Decomposition

Complex issues that touch many files across multiple areas often fail at the build or review stage, requiring costly pipeline reruns. **Decompose** solves this by splitting complex tasks into independent sub-tasks that build in parallel, then merging and verifying the result.

## When to Use

| Command | When to use |
|---------|-------------|
| `@kody` | Simple/medium issues — single-area changes |
| `@kody decompose` | Complex multi-area issues — many files, multiple domains |
| `@kody compose` | Retry compose phase — when decompose's builds succeeded but merge/verify/review/ship failed |

**You don't need to decide upfront.** Decompose automatically scores task complexity (1-10) and falls back to the normal pipeline if the task isn't complex enough to benefit from splitting.

## How It Works

```
@kody decompose                              @kody compose (retry only)
───────────────────────────────────────      ─────────────────────────────
taskify → plan → decompose → parallel build   merge → verify → review → ship
```

### Phase 1: Analyze

1. **Taskify** — classify the issue (same as normal pipeline)
2. **Plan** — generate a full implementation plan with steps and file targets
3. **Decompose** — AI analyzes the plan steps and groups them into independent clusters
   - Scores complexity 1-10
   - Falls back to `@kody` (normal pipeline) if score < 6 or steps can't be cleanly split

### Phase 2: Parallel Build

For each sub-task:
1. Create a git worktree with its own branch
2. Write a scoped plan (only the assigned steps) and file constraints
3. Run the build agent — it can only modify files in its assigned scope
4. Commit changes in the worktree

All sub-tasks build concurrently (default: 3 at a time).

### Phase 3: Compose

1. **Merge** — sequentially merge each sub-task branch into the feature branch
2. **Verify** — run typecheck + tests + lint on the merged code (with autofix)
3. **Review** — AI code review on the complete merged result
4. **Ship** — create one PR for the parent issue

## Fallback Strategy

Decompose is **fail-open** — at any failure point, it delegates to the normal pipeline:

- Decompose agent fails → normal pipeline
- Complexity score too low → normal pipeline
- Any sub-task build fails → normal pipeline
- Merge conflict → normal pipeline

This means decompose is always an optimization, never a blocker.

## CLI Usage

```bash
# Full decompose flow (analyze + parallel build + compose)
kody-engine-lite decompose --issue-number 42 --local

# Skip auto-compose (just build, inspect results manually)
kody-engine-lite decompose --issue-number 42 --no-compose

# Retry compose only (merge + verify + review + ship)
kody-engine-lite compose --task-id 42-260403-221500 --issue-number 42
```

### `decompose`

| Flag | Required | Description |
|------|----------|-------------|
| `--issue-number <n>` | Yes | GitHub issue to decompose |
| `--no-compose` | No | Stop after parallel builds (don't auto-merge/verify/ship) |
| `--cwd <path>` | No | Working directory |
| `--local` | No | Run locally (auto-enabled outside CI) |

### `compose`

| Flag | Required | Description |
|------|----------|-------------|
| `--task-id <id>` | Yes | Task ID from a previous decompose run |
| `--issue-number <n>` | No | GitHub issue number |
| `--cwd <path>` | No | Working directory |
| `--local` | No | Run locally |

Compose is **re-runnable** — if it fails at verify or review, run it again and it skips the merge (already done) and retries from verification.

## Configuration

Add to `kody.config.json`:

```json
{
  "decompose": {
    "enabled": true,
    "maxParallelSubTasks": 3,
    "minComplexityScore": 6
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the decompose command |
| `maxParallelSubTasks` | `3` | Maximum concurrent sub-task builds |
| `minComplexityScore` | `6` | Minimum complexity score (1-10) to trigger decomposition |

## Complexity Scoring

The decompose agent rates task complexity on a 1-10 scale:

| Score | Level | Action |
|-------|-------|--------|
| 1-3 | Simple | Falls back to normal pipeline |
| 4-5 | Moderate | Falls back to normal pipeline (below default threshold) |
| 6-7 | Complex | Decomposes into 2 sub-tasks |
| 8-9 | Very complex | Decomposes into 2-3 sub-tasks |
| 10 | Extremely complex | Decomposes into 3-4 sub-tasks |

Factors: file count, directory spread, inter-step coupling, risk level.

## Sub-Task Isolation

Each sub-task has **exclusive file ownership**:
- No file appears in two sub-tasks' scope
- No plan step is assigned to two sub-tasks
- Build agents receive `constraints.json` that enforces allowed/forbidden files
- Circular dependencies between sub-tasks are detected and rejected

This guarantees that parallel builds don't produce conflicting changes.

## Artifacts

After a decompose run, the task directory contains:

```
.kody/tasks/<task-id>/
├── task.md              # Original issue
├── task.json            # Task classification
├── plan.md              # Full implementation plan
├── decompose.json       # Decomposition analysis (score, sub-tasks)
├── decompose-state.json # Runtime state (branches, outcomes, compose results)
├── subtasks/
│   ├── part-1/          # Sub-task artifacts
│   │   ├── task.md
│   │   ├── task.json
│   │   ├── plan.md      # Sliced plan (only assigned steps)
│   │   └── constraints.json
│   └── part-2/
│       └── ...
├── verify.md            # Verification result (post-merge)
├── review.md            # Review result (post-merge)
└── ship.md              # PR creation result
```

## PR Body

PRs created by decompose include an extra section showing how the task was split:

```markdown
## Decomposed Implementation
This task was split into 2 parallel sub-tasks:
- **part-1:** API layer (3 files)
- **part-2:** UI components (2 files)
```

## Architecture

Decompose is implemented as two standalone commands that reuse existing pipeline executors without modifying the core pipeline:

- `src/commands/decompose.ts` — orchestrates analyze + parallel build + auto-compose
- `src/commands/compose.ts` — orchestrates merge + verify + review + ship
- `src/stages/decompose.ts` — runs the decompose AI agent
- `src/pipeline/sub-pipeline.ts` — runs build in git worktrees with sliced plans
- `src/worktree.ts` — git worktree lifecycle management
- `prompts/decompose.md` — AI prompt for plan-first decomposition

**What stays untouched:** `pipeline.ts`, `STAGES`, `StageName`, `EXECUTOR_REGISTRY` — the entire existing pipeline code.
