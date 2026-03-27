# Architecture

## Source Structure

```
src/
├── bin/cli.ts              # Package CLI: init, run, version (726 lines)
├── entry.ts                # Runtime: arg parsing, preflight, LiteLLM, pipeline launch
├── pipeline.ts             # Pipeline loop: stage execution, state, lock
├── agent-runner.ts         # Claude Code subprocess: spawn, pipe prompt, timeout
├── context.ts              # Prompt assembly: memory + template + task context
├── definitions.ts          # 7 stage definitions (timeouts, models, retries)
├── types.ts                # TypeScript interfaces
├── config.ts               # kody.config.json loader
├── git-utils.ts            # Branch create, commit, push, sync, merge
├── github-api.ts           # Issues, labels, PRs, comments (via gh CLI)
├── verify-runner.ts        # Quality gate execution + error parsing
├── observer.ts             # AI failure diagnosis (5-way classification)
├── retrospective.ts        # Post-run analysis + pattern detection
├── validators.ts           # Output validation (JSON fences, plan, review)
├── memory.ts               # .kody/memory/ reader
├── logger.ts               # Structured logging with CI groups
├── preflight.ts            # Startup health checks
│
├── stages/                 # Stage executors
│   ├── agent.ts            # Agent stage (with taskify JSON retry)
│   ├── gate.ts             # Gate stage (verify command runner)
│   ├── verify.ts           # Verify + autofix loop (diagnosis → fix → retry)
│   ├── review.ts           # Review + fix loop
│   └── ship.ts             # PR creation with rich description
│
├── pipeline/               # Pipeline internals
│   ├── executor-registry.ts # StageName → executor mapping
│   ├── hooks.ts            # Pre/post hooks: labels, complexity, risk gate, commits
│   ├── complexity.ts       # Complexity-based stage filtering
│   ├── questions.ts        # Question detection + GitHub posting
│   ├── state.ts            # Atomic state persistence (write-tmp-rename)
│   └── runner-selection.ts # Per-stage runner selection
│
├── cli/                    # CLI utilities
│   ├── args.ts             # Argument parsing
│   ├── litellm.ts          # LiteLLM health check + auto-start
│   └── task-resolution.ts  # Task ID lookup + generation
│
├── learning/               # Self-improvement
│   └── auto-learn.ts       # Convention extraction from run artifacts
│
└── ci/                     # CI-specific
    ├── parse-inputs.ts     # GitHub Actions input parsing
    └── parse-safety.ts     # Author association validation
```

## End-to-End Data Flow

When someone comments `@kody` on issue #42, here's the complete flow:

```
GitHub Issue #42
  │ comment: "@kody"
  ▼
GitHub Actions (kody.yml)
  │
  ├─ [parse job] ─────────────────────────────────────────────────────
  │   1. Validate author (COLLABORATOR/MEMBER/OWNER only)
  │   2. Add 👀 reaction to comment
  │   3. Parse: mode=full, task_id=42-260327-102254, issue_number=42
  │   4. Output task_id, mode, issue_number to orchestrate job
  │
  ├─ [orchestrate job] ──────────────────────────────────────────────
  │   1. Checkout repo (full history)
  │   2. Install pnpm + node deps
  │   3. Install kody-engine-lite + claude CLI
  │   4. Install LiteLLM proxy (if litellm-config.yaml exists)
  │   5. Configure git user
  │   6. Run: kody-engine-lite run --task-id 42-260327-102254 --issue-number 42
  │   7. Upload .tasks/ artifacts
  │
  └─ [kody-engine-lite entry.ts] ────────────────────────────────────
      1. Parse CLI args
      2. Resolve working directory, task ID
      3. Run preflight checks (claude, git, gh, node, pnpm)
      4. Fetch issue #42 body → write task.md
      5. LiteLLM: health check → auto-start if needed → fallback
      6. Create runners, health check default runner
      7. Build PipelineContext
      8. Post "Pipeline started" comment on issue
      9. runPipeline(ctx)
          │
          ├─ Acquire lock (.tasks/42-260327-102254/.lock)
          ├─ Load/init state (status.json)
          ├─ Set label: kody:planning
          ├─ Create feature branch: 42--issue-title
          ├─ Sync with default branch
          │
          ├─ [taskify] ──────────────────────────────────────
          │   agent-runner spawns: claude --print --model haiku
          │   Prompt: taskify.md + memory + task.md
          │   Output: task.json (type, scope, risk_level, questions)
          │   Post-hooks:
          │     → question gate (pause if questions)
          │     → complexity detection (low/medium/high)
          │     → set label: kody:high + kody:feature
          │
          ├─ [plan] ─────────────────────────────────────────
          │   agent-runner spawns: claude --print --model opus
          │   Prompt: plan.md + memory + task.md + task.json
          │   Output: plan.md (TDD implementation plan)
          │   Post-hooks:
          │     → risk gate (HIGH → pause, post plan, wait for approve)
          │
          ├─ [build] ────────────────────────────────────────
          │   agent-runner spawns: claude --print --model sonnet
          │   Prompt: build.md + memory + task.md + task.json + plan.md
          │   Claude Code uses tools: Read, Write, Edit, Bash, Grep, Glob
          │   Post-hooks:
          │     → git commit: "feat(42-260327-102254): implement task"
          │     → set label: kody:building
          │
          ├─ [verify] ───────────────────────────────────────
          │   verify-runner executes:
          │     1. quality.typecheck (pnpm tsc --noEmit)
          │     2. quality.testUnit (pnpm vitest run)
          │     3. quality.lint (pnpm lint)
          │   If any fail:
          │     → observer.ts: diagnose failure (AI classification)
          │       fixable → lintFix + formatFix + autofix agent → retry
          │       infrastructure → skip (mark passed)
          │       pre-existing → skip (mark passed)
          │       abort → stop pipeline
          │     → retry up to 2 more times
          │
          ├─ [review] ───────────────────────────────────────
          │   agent-runner spawns: claude --print --model opus
          │   Prompt: review.md + memory + git diff
          │   Output: review.md (Verdict: PASS/FAIL + findings)
          │   If FAIL with Critical/Major → proceed to review-fix
          │   Set label: kody:review
          │
          ├─ [review-fix] ───────────────────────────────────
          │   agent-runner spawns: claude --print --model sonnet
          │   Prompt: review-fix.md + memory + review.md findings
          │   Post-hooks:
          │     → git commit: "fix(42-260327-102254): address review"
          │
          ├─ [ship] ─────────────────────────────────────────
          │   1. git push origin 42--issue-title
          │   2. Build PR body (What, Scope, Changes, Verify, Plan)
          │   3. gh pr create --title "feat: ..." --body "..."
          │   4. Post "PR created: #N" comment on issue
          │   Set label: kody:done
          │
          ├─ Auto-learn conventions from artifacts
          ├─ Run retrospective (AI analysis of this run)
          └─ Release lock
```

## Pipeline State Machine

```
              ┌──────────────────────────────────────────┐
              │            Pipeline Context               │
              │  taskId, taskDir, projectDir, runners     │
              │  input: mode, issueNumber, complexity     │
              └──────────────┬───────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │   Load State    │  atomic read from status.json
                    │   Acquire Lock  │  PID-based .lock file
                    └────────┬────────┘
                             │
            ┌────────────────▼────────────────┐
            │         For each stage:          │
            │                                  │
            │  1. Skip check                   │
            │     - fromStage not reached yet  │
            │     - already completed          │
            │     - complexity skip            │
            │                                  │
            │  2. Execute                      │
            │     executor-registry lookup     │
            │     → agent / gate / ship        │
            │                                  │
            │  3. Post-hooks (on success)      │
            │     - question gate              │
            │     - complexity detection       │
            │     - risk gate (HIGH only)      │
            │     - git commit                 │
            │                                  │
            │  4. Write state (atomic)         │
            └────────────────┬────────────────┘
                             │
                    ┌────────▼────────┐
                    │   Finalize      │
                    │   Auto-learn    │
                    │   Retrospective │
                    │   Release lock  │
                    └─────────────────┘
```

## Executor Registry

Stage dispatch uses a flat map instead of an if/else tree:

```typescript
const EXECUTOR_REGISTRY: Record<StageName, StageExecutor> = {
  taskify:      executeAgentStage,
  plan:         executeAgentStage,
  build:        executeAgentStage,
  verify:       executeVerifyWithAutofix,
  review:       executeReviewWithFix,
  "review-fix": executeAgentStage,
  ship:         executeShipStage,
}
```

Adding a new stage: one line in the registry + one entry in `definitions.ts`.

## Verify + Autofix Loop

The most complex stage internally:

```
executeVerifyWithAutofix(ctx, def)
  │
  for attempt = 0..maxRetries:
  │
  ├─ Run gate: typecheck + tests + lint
  │   Pass? → return completed (retries: attempt)
  │
  ├─ Read verify.md errors
  ├─ Get modified files (git diff)
  ├─ AI diagnosis via observer.ts:
  │   │
  │   ├─ infrastructure → return completed (skip)
  │   ├─ pre-existing  → return completed (skip)
  │   ├─ abort         → return failed
  │   └─ fixable/retry → continue to autofix
  │
  ├─ Run lintFix command
  ├─ Run formatFix command
  ├─ Spawn autofix agent with diagnosis.resolution in prompt
  └─ Loop back to verify
```

The observer sends errors + modified files to a cheap model (haiku) which classifies the failure and suggests a fix. That suggestion is injected into the autofix agent's prompt.

## Agent Runner

Thin wrapper around Claude Code subprocess:

```
spawn("claude", [
  "--print",
  "--model", model,
  "--dangerously-skip-permissions",
  "--allowedTools", "Bash,Edit,Read,Write,Glob,Grep"
])
```

Flow:
1. Spawn Claude Code process
2. Pipe assembled prompt via stdin
3. Collect stdout (agent output) and stderr (errors)
4. On timeout: SIGTERM → wait 5s → SIGKILL
5. Return `{ outcome: "completed"|"failed"|"timed_out", output, error }`

Environment injected:
- `ANTHROPIC_BASE_URL` — LiteLLM proxy URL (if configured)
- `SKIP_BUILD` / `SKIP_HOOKS` — prevent recursive builds

## Prompt Assembly

Each agent stage gets a prompt built by `context.ts`:

```
┌─────────────────────────────────────────┐
│ Project Memory                          │
│  .kody/memory/architecture.md           │
│  .kody/memory/conventions.md            │
├─────────────────────────────────────────┤
│ Prompt Template                         │
│  prompts/<stage>.md                     │
│  (YAML frontmatter: name, tools, mode)  │
├─────────────────────────────────────────┤
│ Task Context (injected at {{TASK_CONTEXT}}) │
│  Task ID: 42-260327-102254              │
│  task.md (issue body)                   │
│  task.json (classification)             │
│  plan.md (implementation plan)          │
│  feedback (human answers)               │
└─────────────────────────────────────────┘
```

Context is truncated to prevent token overflow: plan.md capped at 1500 chars, task context at 2000 chars.

## Memory System

```
.kody/memory/
├── architecture.md    # Generated by init: tech stack, frameworks, structure
├── conventions.md     # Auto-updated after each run: patterns, conventions
└── observer-log.jsonl # Retrospective entries (one JSON per line)
```

**architecture.md** — Created once by `init`. Claude Code analyzes the project and writes: language, framework, database, package manager, project structure, key directories.

**conventions.md** — Updated by `auto-learn.ts` after each successful run. Extracts from:
- verify.md → testing framework, lint rules
- review.md → code patterns, naming conventions
- task.json → file organization patterns

**observer-log.jsonl** — Appended by `retrospective.ts` after every run:
```json
{
  "timestamp": "2026-03-27T12:23:01Z",
  "taskId": "29-260327-115542",
  "outcome": "completed",
  "durationMs": 1657000,
  "stageResults": { "taskify": { "state": "completed", "retries": 0 }, ... },
  "observation": "Auth system built successfully with 3 verify retries...",
  "patternMatch": "Lint errors in new React code match pattern from run #24",
  "suggestion": "Add eslint-plugin-react to auto-detect HTML entity issues",
  "pipelineFlaw": { "component": "verify", "issue": "lint errors recurring", "evidence": "3 of last 5 runs had lint failures" }
}
```

## GitHub Actions Workflow

```
kody.yml
  │
  ├─ Triggers:
  │   issue_comment (contains @kody)
  │   workflow_dispatch (manual with inputs)
  │   pull_request_review (changes_requested)
  │   push (src/**, kody.config.json, package.json)
  │
  ├─ Jobs:
  │
  │   [parse] ──────────── issue_comment only
  │   │  Validate author association
  │   │  Add 👀 reaction
  │   │  Parse: mode, task_id, from_stage, feedback
  │   │  Handle approve: convert to rerun + feedback
  │   │
  │   [orchestrate] ────── parse success OR workflow_dispatch
  │   │  Checkout (full depth, persist credentials)
  │   │  Install: pnpm, node deps, kody-engine-lite, claude CLI
  │   │  Install: LiteLLM proxy (if litellm-config.yaml exists)
  │   │  Configure git user
  │   │  Run pipeline with env: ANTHROPIC_API_KEY, GH_TOKEN, task inputs
  │   │  Generate step summary (stage table)
  │   │  Upload .tasks/ artifacts (7-day retention)
  │   │
  │   [smoke-test] ─────── push only
  │   │  Typecheck, CLI loads, dry run
  │   │
  │   [notify-parse-error] ── parse fails
  │   │  Post usage comment
  │   │
  │   [notify-orchestrate-error] ── pipeline fails
  │      Post error + logs link
  │
  └─ Concurrency:
      group: kody-{task_id || issue_number}
      cancel-in-progress: false
```

## State Persistence

### status.json (atomic writes)

```json
{
  "taskId": "42-260327-102254",
  "state": "running",
  "stages": {
    "taskify": { "state": "completed", "retries": 0, "completedAt": "..." },
    "plan": { "state": "completed", "retries": 0, "completedAt": "..." },
    "build": { "state": "running", "retries": 0, "startedAt": "..." },
    "verify": { "state": "pending", "retries": 0 },
    "review": { "state": "pending", "retries": 0 },
    "review-fix": { "state": "pending", "retries": 0 },
    "ship": { "state": "pending", "retries": 0 }
  },
  "createdAt": "2026-03-27T10:22:54Z",
  "updatedAt": "2026-03-27T10:25:00Z"
}
```

Writes use tmp-file + rename pattern for crash safety. PID-based `.lock` file prevents concurrent runs.

### Rerun Behavior

On rerun, the pipeline:
1. Loads existing status.json
2. Resets `running`/`failed`/`timeout` stages to `pending`
3. Skips already-`completed` stages
4. Resumes from `--from` stage or auto-detected paused/failed stage

## Core Types

```typescript
type StageName = "taskify" | "plan" | "build" | "verify" | "review" | "review-fix" | "ship"
type StageType = "agent" | "gate" | "deterministic"

interface PipelineContext {
  taskId: string
  taskDir: string          // .tasks/<task-id>/
  projectDir: string       // repo root
  runners: Record<string, AgentRunner>
  input: {
    mode: "full" | "rerun"
    fromStage?: string
    dryRun?: boolean
    issueNumber?: number
    feedback?: string
    local?: boolean
    complexity?: "low" | "medium" | "high"
  }
}

interface AgentRunner {
  run(stage, prompt, model, timeout, taskDir, options?): Promise<AgentResult>
  healthCheck(): Promise<boolean>
}

interface StageResult {
  outcome: "completed" | "failed" | "timed_out"
  outputFile?: string
  error?: string
  retries: number
}
```

## Development

### Setup

```bash
git clone https://github.com/aharonyaircohen/Kody-Engine-Lite.git
cd Kody-Engine-Lite
pnpm install
```

### Commands

```bash
pnpm typecheck              # TypeScript type check
pnpm test                   # 232 tests across 26 files
pnpm build                  # Build npm package (tsup → dist/bin/cli.js)
pnpm kody run ...           # Dev mode (tsx — runs from source)
npm publish --access public # Publish to npm
```

### Test Coverage

| Category | Files | Tests |
|----------|-------|-------|
| Pipeline orchestration | 3 | ~30 |
| Risk gate | 1 | 7 |
| Approve/question flow | 1 | 11 |
| Stability (atomic writes, locks) | 1 | 9 |
| Validators | 1 | 13 |
| Observer/diagnosis | 1 | 14 |
| Retrospective | 1 | ~15 |
| Git utilities | 1 | 9 |
| Config/context/memory | 3 | ~20 |
| Agent runner | 1 | ~10 |
| Other (definitions, logger, utils) | 12 | ~94 |
| **Total** | **26** | **232** |

### Build

Bundled with [tsup](https://tsup.egoist.dev/) into a single ESM file:

```
src/bin/cli.ts → dist/bin/cli.js (~100KB)
```

Target: Node 22. Single bundle, no external runtime deps.

### Adding a New Stage

1. Add definition to `src/definitions.ts`:
```typescript
{ name: "my-stage", type: "agent", modelTier: "mid", timeout: 300_000, maxRetries: 1, outputFile: "my-stage.md" }
```

2. Add executor to `src/pipeline/executor-registry.ts`:
```typescript
"my-stage": executeAgentStage,  // or a custom executor
```

3. Add `StageName` union member to `src/types.ts`

4. Create prompt template at `prompts/my-stage.md`

5. Update complexity skip rules in `src/pipeline/complexity.ts` if needed
