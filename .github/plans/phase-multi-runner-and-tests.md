# Multi-Runner Support + Complete Test Coverage

## Goal
1. Allow each pipeline stage to use a different agent runner (Claude Code, OpenCode, etc.) via config
2. Complete test coverage for all modules

---

## Part 0: Complexity-Based Stage Skipping

### How it works

Taskify stage already outputs `risk_level: "low|medium|high"` in task.json. After taskify completes, the state machine reads risk_level and filters remaining stages:

| Complexity | Stages that run | Skipped |
|-----------|----------------|---------|
| low (fix/docs) | taskify → build → verify → ship | plan, review, review-fix |
| medium (feature) | taskify → plan → build → verify → review → ship | review-fix |
| high (complex) | taskify → plan → build → verify → review → review-fix → ship | none |

### User override

CLI flag `--complexity low|medium|high` overrides auto-detection:
```bash
pnpm kody run --task-id fix-typo --task "Fix typo" --complexity low
```

If not provided, auto-detect from taskify's risk_level output.

### Complexity labels on issues

After complexity is determined, set a label on the issue:
- `kody:low` — simple fix/docs
- `kody:medium` — standard feature
- `kody:high` — complex/risky

Labels created by `init` alongside lifecycle labels.

### Files to modify

- `src/types.ts` — add `complexity?: "low" | "medium" | "high"` to PipelineContext.input
- `src/state-machine.ts` — add `filterByComplexity()`, read risk_level from task.json after taskify, set complexity label
- `src/entry.ts` — add `--complexity` CLI flag
- `src/bin/cli.ts` — add complexity labels to init
- `src/github-api.ts` — add `setComplexityLabel()` (reuse setLifecycleLabel pattern)

### Implementation (~30 lines total)

```typescript
// state-machine.ts
const COMPLEXITY_SKIP: Record<string, string[]> = {
  low: ["plan", "review", "review-fix"],
  medium: ["review-fix"],
  high: [],
}

function filterByComplexity(stages: StageDefinition[], complexity: string): StageDefinition[] {
  const skip = COMPLEXITY_SKIP[complexity] ?? []
  return stages.filter(s => !skip.includes(s.name))
}

// After taskify completes, read risk_level:
const taskJson = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"))
const complexity = ctx.input.complexity ?? taskJson.risk_level ?? "high"
const activeStages = filterByComplexity(STAGES, complexity)
// Set label: setComplexityLabel(issueNumber, complexity)
```

---

## Part 1: Per-Stage Runner Switching

### Config shape (`kody.config.json`)

```json
{
  "agent": {
    "defaultRunner": "claude",
    "runners": {
      "claude": { "type": "claude-code" },
      "opencode": { "type": "opencode" }
    },
    "stageRunners": {
      "taskify": "opencode",
      "plan": "opencode",
      "build": "claude",
      "review": "opencode",
      "review-fix": "claude",
      "autofix": "claude"
    },
    "modelMap": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" }
  }
}
```

**Backward compatible:** If no `runners`/`stageRunners` in config, falls back to current single-runner behavior (`runner: "claude-code"`).

### Files to modify

#### `src/config.ts` — Update KodyConfig.agent

```typescript
agent: {
  // Legacy (still works)
  runner?: string                          // "claude-code" — backward compat
  modelMap: { cheap: string; mid: string; strong: string }
  litellmUrl?: string
  usePerStageRouting?: boolean

  // New: multi-runner
  defaultRunner?: string                   // "claude" — fallback for stages not in stageRunners
  runners?: Record<string, RunnerConfig>   // named runner definitions
  stageRunners?: Record<string, string>    // stage → runner name mapping
}

interface RunnerConfig {
  type: "claude-code" | "opencode"
}
```

#### `src/types.ts` — Replace single runner with runners map

```typescript
interface PipelineContext {
  taskId: string
  taskDir: string
  projectDir: string
  runners: Record<string, AgentRunner>  // was: runner: AgentRunner
  input: { ... }
}
```

#### `src/agent-runner.ts` — Add OpenCode runner + factory

New exports:
- `createOpenCodeRunner(): AgentRunner` — spawns `opencode github run --agent <stageName>`, pipes prompt via stdin, same timeout/stderr pattern
- `createRunners(config: KodyConfig): Record<string, AgentRunner>` — reads config.agent.runners, instantiates each, returns map. Falls back to `{ claude: createClaudeCodeRunner() }` if no runners configured.

OpenCode invocation:
```bash
opencode github run --agent <stageName> < prompt.txt
```
Same subprocess pattern as Claude Code runner — spawn, stdin, timeout, collect stdout/stderr.

#### `src/state-machine.ts` — Resolve runner per stage

```typescript
function getRunnerForStage(ctx: PipelineContext, stageName: string): AgentRunner {
  const config = getProjectConfig()
  const runnerName = config.agent.stageRunners?.[stageName]
    ?? config.agent.defaultRunner
    ?? Object.keys(ctx.runners)[0]
    ?? "claude"
  const runner = ctx.runners[runnerName]
  if (!runner) throw new Error(`Runner "${runnerName}" not found for stage ${stageName}`)
  return runner
}
```

Replace all `ctx.runner.run(...)` with `getRunnerForStage(ctx, def.name).run(...)`.

#### `src/entry.ts` — Create runners map

```typescript
import { createRunners } from "./agent-runner.js"

const runners = createRunners(config)
// Health check the default runner
const defaultName = config.agent.defaultRunner ?? "claude"
const healthy = await runners[defaultName]?.healthCheck()

const ctx: PipelineContext = { ..., runners }
```

#### `README.md` — Document multi-runner config

Add section explaining:
- Default behavior (Claude Code only)
- How to add OpenCode runner
- Per-stage runner assignment
- Example: MiniMax for reasoning, Claude for execution

---

## Part 2: Complete Test Coverage

### Test structure

```
tests/
  unit/
    config.test.ts           — config loading, defaults, merge, cache
    context.test.ts          — prompt reading, context injection, model resolution, memory
    validators.test.ts       — taskify JSON, plan markdown, review markdown validation
    memory.test.ts           — readProjectMemory, empty dir, missing dir
    kody-utils.test.ts       — ensureTaskDir, getTaskDir
    definitions.test.ts      — STAGES array, getStage helper
    agent-runner.test.ts     — createClaudeCodeRunner, createOpenCodeRunner, createRunners factory
    state-machine.test.ts    — state management, stage dispatch, resume, verify loop, review loop
    logger.test.ts           — log levels, CI groups
  int/
    pipeline.test.ts         — dry-run pipeline end-to-end with mock runner
```

### What each test covers

**config.test.ts:**
- Loads defaults when no kody.config.json
- Merges user config with defaults
- Cache works (returns same object)
- resetProjectConfig clears cache
- setConfigDir changes config path
- Handles invalid JSON gracefully
- New: runners/stageRunners config parsing

**context.test.ts:**
- readPromptFile finds prompts in multiple paths
- readPromptFile throws for missing prompts
- injectTaskContext replaces {{TASK_CONTEXT}} with artifacts
- injectTaskContext handles missing artifacts gracefully
- injectTaskContext includes feedback when provided
- resolveModel maps tiers to model names
- resolveModel supports per-stage routing
- buildFullPrompt combines memory + prompt + context

**validators.test.ts:**
- validateTaskJson passes with all 5 fields
- validateTaskJson fails with missing fields
- validateTaskJson fails with invalid JSON
- validatePlanMd passes with h2 sections
- validatePlanMd fails when too short
- validatePlanMd fails without h2
- validateReviewMd passes with "pass" or "fail"
- validateReviewMd fails without verdict

**memory.test.ts:**
- Returns empty string for missing directory
- Returns empty string for empty directory
- Concatenates multiple .md files with headers
- Ignores non-.md files

**kody-utils.test.ts:**
- ensureTaskDir creates directory
- ensureTaskDir returns path
- ensureTaskDir is idempotent

**definitions.test.ts:**
- STAGES has 7 entries
- Each stage has required fields
- getStage returns correct stage
- getStage returns undefined for unknown

**agent-runner.test.ts:**
- createClaudeCodeRunner returns AgentRunner interface
- createOpenCodeRunner returns AgentRunner interface
- createRunners reads config and creates map
- createRunners falls back to claude-only when no config
- healthCheck returns boolean

**state-machine.test.ts (with mock runner):**
- initState creates all stages as pending
- loadState/writeState round-trip
- Pipeline runs all stages in order
- Pipeline stops on failure
- Pipeline skips completed stages on rerun
- Pipeline resumes from fromStage
- Dry run skips agent calls
- getRunnerForStage selects correct runner per config
- Verify+autofix loop retries
- Review+fix loop triggers on FAIL verdict

**logger.test.ts:**
- Logs at correct levels
- ciGroup/ciGroupEnd output in CI mode

**pipeline.test.ts (integration):**
- Create mock runner that returns canned responses
- Run full pipeline with dry-run
- Verify status.json created with correct structure
- Verify all stages marked completed

---

## Verification

```bash
pnpm typecheck                    # All files compile
pnpm test                         # All tests pass
pnpm test -- --coverage           # Check coverage
```
