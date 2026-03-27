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

Adding a new stage is one line in the registry + one entry in `definitions.ts`.

## Agent Runner

The agent runner is a thin wrapper around Claude Code:

```
spawn("claude", ["--print", "--model", model, "--dangerously-skip-permissions", "--allowedTools", "Bash,Edit,Read,Write,Glob,Grep"])
  → pipe prompt via stdin
  → collect stdout (agent output)
  → collect stderr (errors)
  → timeout → SIGTERM → SIGKILL
  → return { outcome, output, error }
```

Environment variables `ANTHROPIC_BASE_URL` and `SKIP_BUILD`/`SKIP_HOOKS` are injected.

## Prompt Assembly

Each agent stage gets a prompt built from:

```
[Project Memory]           .kody/memory/architecture.md + conventions.md
[Prompt Template]          prompts/<stage>.md (with YAML frontmatter)
[Task Context]             task.md + task.json + plan.md + feedback
[Human Feedback]           --feedback flag or comment body
```

The `{{TASK_CONTEXT}}` placeholder in prompt templates is replaced with the assembled context.

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
src/bin/cli.ts → dist/bin/cli.js (100KB)
```

Target: Node 22. All dependencies are bundled except `dotenv`.
