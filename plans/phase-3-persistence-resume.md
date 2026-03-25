# Phase 3 — Persistence & Resume

## Goal
Add state management so the pipeline can resume from a failed stage, and add the full 7-stage pipeline with verify+autofix and review+fix loops.

## Prerequisite
Phase 2 complete — multi-stage pipeline runs end-to-end.

## What gets built

### New files

| File | ~Lines | Purpose |
|------|--------|---------|
| `src/config.ts` | ~150 | Config system: kody.config.json + env vars + pipeline constants |
| `src/logger.ts` | ~70 | Pino logger with CI groups |
| `src/verify-runner.ts` | ~150 | Quality gates: typecheck, lint, test |
| `src/preflight.ts` | ~60 | Startup checks: claude CLI, git, pnpm, node |
| `prompts/autofix.md` | ~50 | Fix verification errors (tool-use) |
| `prompts/review-fix.md` | ~50 | Fix review issues (tool-use) |
| `kody.config.json` | ~25 | Default project config |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Add `PipelineStatus`, `StageState`, `PipelineState`, `PipelineContext.input` (mode, fromStage, dryRun) |
| `src/definitions.ts` | Expand to 7 stages (add verify, review-fix, ship), add `retryWithAgent` |
| `src/state-machine.ts` | Add state persistence, resume logic, verify+autofix loop, review+fix loop, ship stub |
| `src/entry.ts` | Add `rerun` and `status` commands, `--from`, `--dry-run`, `--help` flags, preflight |

## Full 7-stage pipeline

| Stage | Type | Model | Timeout | Retries | Output | retryWithAgent |
|-------|------|-------|---------|---------|--------|---------------|
| taskify | agent | cheap | 3m | 1 | task.json | — |
| plan | agent | mid | 5m | 1 | plan.md | — |
| build | agent | strong | 20m | 1 | — | — |
| verify | gate | — | 5m | 2 | verify.md | autofix |
| review | agent | mid | 5m | 1 | review.md | — |
| review-fix | agent | strong | 10m | 1 | — | — |
| ship | deterministic | — | 2m | 1 | ship.md | — |

## Implementation details

### State persistence (`status.json`)

```typescript
interface PipelineStatus {
  taskId: string
  state: "running" | "completed" | "failed"
  stages: Record<StageName, StageState>
  createdAt: string
  updatedAt: string
}

interface StageState {
  state: "pending" | "running" | "completed" | "failed" | "timeout"
  startedAt?: string
  completedAt?: string
  retries: number
  error?: string
  outputFile?: string
}
```

- `loadState(taskId, taskDir)` — load `.tasks/<id>/status.json`, validate taskId
- `writeState(state, taskDir)` — write with updated timestamp. **Called after EVERY stage.**
- `initState(taskId)` — all stages `{ state: "pending", retries: 0 }`

### Resume logic (`rerun --from <stage>`)
- If `state.state !== "running"`: reset to running, reset failed/running stages to pending
- `fromStage` flag: skip all stages before the target (dual-flag pattern from Kody-Engine lines 429-441)
- Skip already-completed stages

### Verify + autofix loop (`executeVerifyWithAutofix`)
```
for attempt = 0 to maxRetries (2):
  run quality gates (typecheck → test → lint)
  if pass → return completed
  if fail + attempts remain:
    run lintFix command (silently ignore failure)
    run formatFix command (silently ignore failure)
    run autofix agent via runner.run("autofix", ...)
  continue
after all attempts → return failed
```

### Review + review-fix loop (`executeReviewWithFix`)
```
run review agent → review.md
check: hasIssues = /\bfail\b/i.test(content) && !/pass/i.test(content)
if no issues → return
if has issues → run review-fix agent → re-run review → return second result
```

### Ship stage (Phase 3: stub)
- Write `ship.md` with "Ship stage skipped — no git integration yet"
- Real implementation in Phase 6

### Config system (`src/config.ts`)
```typescript
interface KodyConfig {
  quality: { typecheck, lint, lintFix, format, formatFix, testUnit }
  git: { defaultBranch }
  paths: { taskDir }
  agent: { runner, modelMap: { cheap, mid, strong } }
}
```
- Load from `kody.config.json`, deep merge with defaults
- Cache with `resetProjectConfig()` for testing
- Pipeline constants: `SIGKILL_GRACE_MS`, `MAX_PR_TITLE_LENGTH`, `STDERR_TAIL_LINES`, `API_TIMEOUT_MS`, `DEFAULT_MAX_FIX_ATTEMPTS`, `AGENT_RETRY_DELAY_MS`, `MAX_TASK_CONTEXT_SPEC: 2000`, `MAX_TASK_CONTEXT_PLAN: 1500`
- Env vars: `TASK_ID`, `MODE`, `FROM_STAGE`, `DRY_RUN`, `GITHUB_ACTIONS`, `LOG_LEVEL`, `ANTHROPIC_API_KEY`

### Logger (`src/logger.ts`)
- Pino + pino-pretty, lazy init
- Colorization off when `GITHUB_ACTIONS=true`
- `createStageLogger(stage, taskId?)`
- `ciGroup(title)` / `ciGroupEnd()` for GitHub Actions grouping

### Verify runner (`src/verify-runner.ts`)
- `runCommand(cmd, cwd, timeout)` — spawn, `FORCE_COLOR=0`, capture output
- `parseErrors(output)` — regex for error patterns, cap 500 chars per line
- `runQualityGates(taskDir, projectRoot?)` — run typecheck → test → lint from config

### Preflight (`src/preflight.ts`)
1. `claude --version` — CLI available
2. `git rev-parse --is-inside-work-tree` — git repo
3. `pnpm --version` — pnpm available
4. `node --version` → major ≥ 18
5. `package.json` exists

### CLI updates (`src/entry.ts`)
```
pnpm kody run    --task-id <id> [--task "<text>"] [--dry-run]
pnpm kody rerun  --task-id <id> --from <stage>
pnpm kody status --task-id <id>
pnpm kody --help
```

## What is NOT in Phase 3
- No GitHub integration (no PRs, labels, comments)
- No git operations (no branches, commits, push)
- No memory system
- No LiteLLM
- No Superpowers methodology in prompts
- No CI/CD workflow

## Success criteria
```bash
# Full pipeline with all 7 stages
pnpm kody run --task-id 260325-test --task "Add a multiply function"
cat .tasks/260325-test/status.json  # All stages completed

# Resume from failure
pnpm kody rerun --task-id 260325-test --from review
cat .tasks/260325-test/status.json  # Review re-ran, earlier stages skipped

# Status check
pnpm kody status --task-id 260325-test  # Shows per-stage status

# Verify loop works
# (intentionally break a test, verify detects, autofix fixes, verify passes)

# Dry run
pnpm kody run --task-id dry-test --task "Test" --dry-run
cat .tasks/dry-test/status.json  # Created but no agent calls made
```
