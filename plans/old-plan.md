# Current Task: Multi-Runner Support + Complete Test Coverage

## Part 1: Per-stage runner switching

Add ability to use different agent runners (Claude Code, OpenCode, etc.) per pipeline stage via config.

### Config shape (`kody.config.json`):
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
    }
  }
}
```

### Files to modify:
- `src/config.ts` — update KodyConfig.agent with runners, stageRunners, defaultRunner
- `src/types.ts` — PipelineContext.runners: Record<string, AgentRunner> (replaces single runner)
- `src/agent-runner.ts` — add createOpenCodeRunner(), add createRunners(config) factory
- `src/state-machine.ts` — resolve runner per stage from config
- `src/entry.ts` — create runners map, pass to context
- `README.md` — document multi-runner config

### Backward compatible:
If no `runners`/`stageRunners` in config, falls back to single `runner: "claude-code"` behavior.

## Part 2: Complete test coverage

Unit tests for every module + integration test for pipeline flow.

### Test files:
- `tests/unit/config.test.ts`
- `tests/unit/context.test.ts`
- `tests/unit/validators.test.ts`
- `tests/unit/memory.test.ts`
- `tests/unit/kody-utils.test.ts`
- `tests/unit/definitions.test.ts`
- `tests/unit/agent-runner.test.ts`
- `tests/unit/state-machine.test.ts`
- `tests/unit/logger.test.ts`
- `tests/int/pipeline.test.ts`

## Verification
```bash
pnpm typecheck
pnpm test
```

**Architecture:**
```
GitHub Actions / CLI
     ↓
Kody (thin wrapper: CLI, GitHub, config, logging, stage orchestration)
     ↓
Agent Runner (interface — swappable)
     ↓
Claude Code + Superpowers (default execution engine)
     ↓
LiteLLM Proxy (unified model routing — replaces opencode.json + direct provider keys)
     ↓
LLMs (Anthropic, OpenAI, MiniMax, etc.)
```

**Key decisions:**
- Kody orchestrates stages (Option A) — each stage is a fresh Claude Code invocation
- **LiteLLM replaces all model configuration** — opencode.json's 21 agent→model mappings become LiteLLM aliases
- Per-stage model selection via LiteLLM aliases passed to Claude Code `--model` flag
- Filesystem persistence for resumability (`.kody/tasks/<id>/status.json`)
- Agent Runner interface for swappability (replace Claude Code later without touching state machine)
- Claude Code uses tools (Read, Write, Edit, Bash) to modify files directly in the working directory

**Repo strategy:** Build on current repo. Delete all files in `src/` (the 3-stage demo is incompatible). Keep: `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`. Rewrite `litellm-config.yaml` with full agent mappings.

---

## Orchestrator Design Principle — Keep Kody Minimal

The orchestrator (Kody) must remain intentionally minimal. Its responsibility is limited to running stages sequentially, persisting state, and handling basic failure/resume logic. Kody must NOT implement reasoning, planning, retry intelligence, branching logic, or agent decision-making. All intelligence and execution discipline must be delegated to external systems: Claude Code for reasoning and execution, Superpowers for structured workflow discipline, and LiteLLM for model routing. The orchestrator should function as a **simple stage runner — deterministic, predictable, and dumb by design** — to prevent long-term architectural complexity and maintain system scalability.

**Kody does:**
- Run stages in order
- Read/write state files
- Pass artifacts between stages
- Spawn agents and collect results
- Call git/gh commands (ship stage)
- Basic retry loops (verify+autofix, review+fix) — but the loop logic is fixed, not intelligent

**Kody does NOT:**
- Decide which stage to run next based on content analysis
- Interpret agent output beyond pass/fail
- Make model selection decisions (LiteLLM handles this)
- Implement planning or reasoning logic (Brain/Claude Code handles this)
- Add complexity that requires its own testing or debugging

### Agent Runner Design Principle — Keep It Minimal

The Agent Runner must remain extremely minimal and must not evolve into a secondary orchestrator. Its responsibility is limited to: spawning Claude Code, passing input, enforcing timeout, and returning output. The Agent Runner must NOT implement reasoning logic, context management, execution modes, fuzzy detection, or workflow intelligence. All decision-making and execution discipline must be delegated to Claude Code and Superpowers. The Agent Runner should function as a **thin subprocess wrapper only** — ensuring simplicity, stability, and long-term maintainability.

**Agent Runner does:**
- Spawn Claude Code process with model + prompt
- Pipe prompt via stdin, collect stdout/stderr
- Enforce timeout (SIGTERM → SIGKILL)
- Return exit code + output text
- Check if expected output file exists

**Agent Runner does NOT:**
- Parse or interpret agent output content
- Manage context assembly (state machine reads artifacts and builds prompt)
- Implement retry logic (state machine owns retries)
- Make decisions based on output quality
- Handle memory injection (memory.ts provides content; state machine assembles)

---

## LiteLLM: Unified Model Routing (replaces opencode.json)

### Current state: fragmented model config

**opencode.json** (21 agents, 3 providers):
| Agent | Model | Provider |
|-------|-------|----------|
| build, plan, architect, taskify, gap, plan-gap, autofix, verify, test, pr, kody-expert, test-writer, browser, fix, reflect, e2e-test-writer | MiniMax-M2.7-highspeed | MiniMax |
| clarify, advisor | gpt-5.2 | OpenAI |
| build-manager, review | claude-opus-4-6 | Anthropic |

**Problem:** Model assignments are scattered across opencode.json, hardcoded per agent. Changing a model requires editing the agent config, not a routing layer.

### New state: LiteLLM as single source of truth

All model routing moves to `litellm-config.yaml`. The Agent Runner passes the **stage name** as the model alias. LiteLLM resolves it to the actual provider/model.

```yaml
# litellm-config.yaml — complete agent-to-model routing
model_list:
  # ── Tier aliases (used by kody.config.json modelMap) ──
  - model_name: cheap
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: cheap    # fallback
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

  - model_name: mid
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: mid      # fallback
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  - model_name: strong
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: strong    # fallback
    litellm_params:
      model: openai/gpt-4
      api_key: os.environ/OPENAI_API_KEY

  # ── Per-stage aliases (1:1 mapping from opencode.json agents) ──
  # Fast analysis / classification
  - model_name: taskify
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY

  # Planning — needs reasoning
  - model_name: plan
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  # Code generation — strongest model
  - model_name: build
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  # Quality gate fixes — mid-tier
  - model_name: autofix
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  # Code review — strongest for thoroughness
  - model_name: review
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  # Fix review issues — strong
  - model_name: review-fix
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  # ── Future stage aliases (not in Phase 1 pipeline) ──
  - model_name: clarify
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: test-writer
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: reflect
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

### How it integrates

**Phase 1 (simple):** Agent Runner maps `stage.modelTier` → Claude model name directly (`cheap→haiku`, `mid→sonnet`, `strong→opus`). No LiteLLM proxy needed. Config lives in `kody.config.json`.

**Phase 2 (with LiteLLM proxy):** Agent Runner passes `stage.name` as model alias to Claude Code. Set `ANTHROPIC_BASE_URL=http://localhost:4000` so requests route through LiteLLM. LiteLLM handles provider selection, fallback, cost tracking. The kody.config.json `modelMap` switches from direct names to LiteLLM aliases.

**Phase 2 config change:**
```json
// kody.config.json — Phase 1
{ "agent": { "modelMap": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" } } }

// kody.config.json — Phase 2 (LiteLLM)
{ "agent": { "modelMap": { "cheap": "cheap", "mid": "mid", "strong": "strong" }, "litellmUrl": "http://localhost:4000" } }
// OR per-stage routing:
{ "agent": { "usePerStageRouting": true, "litellmUrl": "http://localhost:4000" } }
```

---

## Memory & Context Persistence

Each Claude Code invocation is a fresh session. Two layers of context maintain continuity:

### Short-term: Task Context (per-task)
- **Location:** `.kody/tasks/<id>/`
- **Contents:** task.json, plan.md, review.md, verify.md, status.json
- **Injected via:** `{{TASK_CONTEXT}}` placeholder in prompts
- **Lifetime:** One pipeline run. Persists for resume/rerun.

### Long-term: Project Memory (shared across tasks)
- **Location:** `.kody/memory/`
- **Contents:** Manually seeded + auto-learned:
  - `conventions.md` — coding conventions, frameworks, patterns
  - `architecture.md` — system design, key modules
  - `known-issues.md` — gotchas, workarounds
- **Git-tracked:** Yes
- **Injected via:** Agent Runner reads all `.kody/memory/*.md`, concatenates, prepends to system prompt
- **Auto-learn:** Post-pipeline, extract learnings from review.md/verify.md → append to conventions.md

### Injection flow
```
1. Read .kody/memory/*.md → projectMemory
2. Read prompts/<stage>.md → stagePrompt
3. Read task artifacts → taskContext
4. Final = projectMemory + stagePrompt.replace("{{TASK_CONTEXT}}", taskContext)
5. Pass to Claude Code
```

---

## Agent Execution Model

### Two execution modes in Agent Runner

| Stage | Mode | Claude Code invocation | Kody handles output |
|-------|------|----------------------|---------------------|
| taskify | print | `claude --print --model <alias>` | Capture stdout → `task.json` |
| plan | print | `claude --print --model <alias>` | Capture stdout → `plan.md` |
| build | tool-use | `claude --print --model <alias>` (agent uses Read/Write/Edit/Bash) | Check exit code; agent wrote files directly |
| verify | gate | N/A — Kody runs quality commands | Write `verify.md` report |
| review | print | `claude --print --model <alias>` | Capture stdout → `review.md` |
| review-fix | tool-use | `claude --print --model <alias>` (agent uses tools) | Check exit code; agent edited files |
| autofix | tool-use | `claude --print --model <alias>` (agent uses tools) | Check exit code; agent fixed files |
| ship | deterministic | N/A — Kody runs git/gh commands | Write `ship.md` |

Note: `--print` is always used (no interactive TUI). Tool-use stages still execute tools server-side. The difference is in the **prompt instructions**: print-mode prompts ask for structured text output, tool-use prompts instruct the agent to modify files.

---

## Phase 1: Working Skeleton ✅ COMPLETE

Implemented and tested 2026-03-25. CLI → AgentRunner → Claude Code → file written. See `plans/phase-1-minimal-pipeline.md`.

Files created: `src/types.ts`, `src/agent-runner.ts`, `src/entry.ts`, `src/kody-utils.ts`, `prompts/build.md`

---

## Phase 2: Multi-Stage Pipeline (NEXT)

See `plans/phase-2-multi-stage.md` for detailed plan.

### Step 1: Types (`src/types.ts`) ~90 lines

Port from Kody-Engine `types.ts` (63 lines). Add AgentRunner interface and modelTier.

```typescript
type StageName = "taskify" | "plan" | "build" | "verify" | "review" | "review-fix" | "ship"
type StageType = "agent" | "gate" | "deterministic"
type PipelineState = "pending" | "running" | "completed" | "failed" | "timeout"

interface StageDefinition {
  name: StageName
  type: StageType
  modelTier: "cheap" | "mid" | "strong"
  timeout: number
  maxRetries: number
  outputFile?: string
  retryWithAgent?: string  // e.g., "autofix" for verify stage
}

interface StageState {
  state: PipelineState
  startedAt?: string
  completedAt?: string
  retries: number
  error?: string
  outputFile?: string
}

interface PipelineStatus {
  taskId: string
  state: "running" | "completed" | "failed"
  stages: Record<StageName, StageState>
  createdAt: string
  updatedAt: string
}

interface StageResult {
  outcome: "completed" | "failed" | "timed_out"
  outputFile?: string
  error?: string
  retries: number
}

interface AgentResult {
  outcome: "completed" | "failed" | "timed_out"
  output?: string
  error?: string
  outputFile?: string
}

interface AgentRunner {
  run(stageName: string, promptPath: string, timeout: number,
      taskId: string, taskDir: string, options?: AgentRunnerOptions): Promise<AgentResult>
  healthCheck(): Promise<boolean>
}

interface AgentRunnerOptions {
  cwd?: string
  env?: Record<string, string>
  modelTier?: "cheap" | "mid" | "strong"
  outputFile?: string
}

interface PipelineContext {
  taskId: string
  taskDir: string
  input: {
    mode: "full" | "rerun" | "status"
    dryRun?: boolean
    issueNumber?: number
    feedback?: string
    fromStage?: string
    local?: boolean  // Skip GitHub API calls
  }
  runner: AgentRunner
}

interface ValidationResult { valid: boolean; error?: string }
```

### Step 2: Stage Definitions (`src/definitions.ts`) ~70 lines

Port from Kody-Engine `definitions.ts` (62 lines). Add `modelTier`. Add `getStage()` helper.

| Stage | Type | Model Tier | Timeout | Retries | Output | retryWithAgent |
|-------|------|-----------|---------|---------|--------|---------------|
| taskify | agent | cheap | 3m | 1 | task.json | — |
| plan | agent | mid | 5m | 1 | plan.md | — |
| build | agent | strong | 20m | 1 | — | — |
| verify | gate | — | 5m | 2 | — | autofix |
| review | agent | mid | 5m | 1 | review.md | — |
| review-fix | agent | strong | 10m | 1 | — | — |
| ship | deterministic | — | 2m | 1 | — | — |

### Step 3: Logger (`src/logger.ts`) ~70 lines

Port from Kody-Engine `logger.ts` (76 lines).
- Pino + pino-pretty transport
- Lazy initialization (avoid validation at import)
- Colorization disabled when `GITHUB_ACTIONS=true`
- `createStageLogger(stage, taskId?)` for scoped logging
- `ciGroup(title)` / `ciGroupEnd()` — write `::group::` / `::endgroup::` to stdout in CI

### Step 4: Config (`src/config.ts`) ~150 lines

Port from Kody-Engine `config.ts` (195 lines). Use zod (not znv).

```typescript
interface KodyConfig {
  quality: {
    typecheck: string   // "pnpm -s tsc --noEmit"
    lint: string        // "pnpm -s lint"
    lintFix: string     // "pnpm lint:fix"
    format: string      // "pnpm -s format:check"
    formatFix: string   // "pnpm format:fix"
    testUnit: string    // "pnpm -s test:unit"
  }
  git: {
    defaultBranch: string  // "dev"
    userEmail?: string
    userName?: string
  }
  github: {
    owner: string
    repo: string
  }
  paths: {
    taskDir: string  // ".kody/tasks"
  }
  agent: {
    runner: "claude-code"
    modelMap: { cheap: string; mid: string; strong: string }
    litellmUrl?: string  // Phase 2: "http://localhost:4000"
    usePerStageRouting?: boolean  // Phase 2: use stage name as model alias
  }
}
```

**Implementation details:**
- Load from `kody.config.json` in project root, deep merge with defaults (shallow per section)
- Cache with `resetProjectConfig()` for testing
- Env cache with `resetEnv()` for testing
- Pipeline constants:
  - `SIGKILL_GRACE_MS: 5000` — grace period before SIGKILL
  - `MAX_PR_TITLE_LENGTH: 72` — truncate PR titles
  - `STDERR_TAIL_LINES: 50` — max stderr lines in error
  - `API_TIMEOUT_MS: 30000` — gh CLI timeout
  - `MAX_PIPELINE_LOOP_ITERATIONS: 200` — safety limit
  - `DEFAULT_MAX_FIX_ATTEMPTS: 2` — verify retry default
  - `MAX_BUILD_FEEDBACK_LOOPS: 2` — build retry cap
  - `AGENT_RETRY_DELAY_MS: 2000` — delay between retries
  - `MAX_SPEC_SUMMARY_LENGTH: 500` — truncate spec in context
  - `MAX_TASK_CONTEXT_SPEC: 2000` — spec.md char limit in context injection
  - `MAX_TASK_CONTEXT_PLAN: 1500` — plan.md char limit in context injection
- Default log level: `"info"`, validated against `["debug", "info", "warn", "error", "silent"]`

**Environment variables** (parsed with zod, all optional):
| Var | Used by | Phase |
|-----|---------|-------|
| `TASK_ID` | entry.ts (CI mode) | 1 |
| `MODE` | entry.ts (CI mode) | 1 |
| `FROM_STAGE` | entry.ts (CI mode) | 1 |
| `ISSUE_NUMBER` | entry.ts (CI mode) | 2 |
| `FEEDBACK` | entry.ts (CI mode) | 2 |
| `DRY_RUN` | entry.ts (CI mode) | 1 |
| `GH_TOKEN` | github-api.ts, ship stage | 2 |
| `GH_PAT` | github-api.ts (preferred over GH_TOKEN) | 2 |
| `GITHUB_ACTIONS` | logger, entry.ts (CI detection) | 1 |
| `LOG_LEVEL` | logger.ts | 1 |
| `ANTHROPIC_API_KEY` | Claude Code CLI | 1 |
| `OPENAI_API_KEY` | LiteLLM fallback | 2+ |
| `LITELLM_BASE_URL` | agent-runner (proxy URL) | 2+ |
| `LITELLM_MASTER_KEY` | LiteLLM proxy auth | 2+ |
| `GIT_USER_EMAIL` | git config in CI | 2 |
| `GIT_USER_NAME` | git config in CI | 2 |
| `GITHUB_REPOSITORY` | github-api (extract owner/repo) | 2 |
| `GITHUB_EVENT_NAME` | entry.ts (trigger type) | 3 |
| `RUN_ID` | error notifications (link to logs) | 3 |
| `RUN_URL` | error notifications (link to logs) | 3 |
| `ISSUE_CREATOR` | parse job (safety validation) | 3 |
| `GITHUB_ACTOR` | parse job (safety validation) | 3 |
| `APP_PRIVATE_KEY` | GitHub App token generation in CI | 3 |

### Step 5: Agent Runner (`src/agent-runner.ts`) ~120 lines + Context Builder (`src/context.ts`) ~80 lines

Port subprocess pattern from Kody-Engine `agent-runner-v2.ts` (256 lines), adapted for Claude Code. **Split into two modules** per the Agent Runner Design Principle: runner is a thin wrapper, context assembly is separate.

**The Agent Runner is a thin subprocess wrapper.** Context assembly (reading artifacts, memory, building prompts) lives in the state machine, NOT in the runner.

**Runner functions (minimal):**
- `createClaudeCodeRunner(config): AgentRunner` — factory
- `run(stageName, prompt, model, timeout, taskDir, options?)` — the core method:
  1. Spawn `claude --print --model <model> --dangerously-skip-permissions --allowedTools "Bash,Edit,Read,Write,Glob,Grep"` with `stdio: ["pipe", "pipe", "pipe"]`
  2. **Stdin handling:** wrap stdin.write() in Promise — write prompt, call stdin.end(), resolve on drain (matches Kody-Engine agent-runner-v2.ts lines 90-104)
  3. Wait for process exit with timeout — SIGTERM, then SIGKILL after `SIGKILL_GRACE_MS` (5s). Collect stderr as Buffers, concat on exit.
  4. If `options.outputFile`: check file exists (1s sleep, exact path, then fuzzy variant `expectedBase-*ext`, rename if variant)
  5. Return `AgentResult { outcome, output, error, outputFile }`
- `healthCheck()` — run `npx claude --version`, return true if exit 0

**Success criteria:**
- exit 0 + output file found → completed
- exit 0 + output file expected but missing → failed ("no output file produced")
- exit 0 + no output file expected → completed
- exit non-0 → failed (include last 500 chars of stderr)

**Environment injected:** `SKIP_BUILD=1`, `SKIP_HOOKS=1`

**What moved OUT of agent-runner (to state machine / other modules):**
- `injectTaskContext()` → `src/context.ts` (new, ~60 lines) — reads task.json, spec.md, plan.md, replaces `{{TASK_CONTEXT}}`
- `readProjectMemory()` → `src/memory.ts` (already planned)
- `readPromptFile()` → `src/context.ts` — reads from `prompts/` directory
- `resolveModel()` → `src/config.ts` — model resolution from config
- Context assembly flow lives in `executeAgentStage()` in state-machine.ts:
  ```
  1. memory = readProjectMemory(".kody/memory/")
  2. prompt = readPromptFile("prompts/<stage>.md")
  3. context = injectTaskContext(prompt, taskId, taskDir, stageName)
  4. fullPrompt = memory + context
  5. model = resolveModel(def.name, config)
  6. result = ctx.runner.run(def.name, fullPrompt, model, def.timeout, ctx.taskDir, { outputFile: def.outputFile })
  ```

### Step 6: Verify Runner (`src/verify-runner.ts`) ~150 lines

Port from Kody-Engine `verify-runner.ts` (227 lines).

**Functions:**
- `runCommand(cmd, cwd, timeout)` — spawn subprocess, `FORCE_COLOR=0`, capture stdout/stderr, return `{ success, errors[], timedOut }`. Command split on whitespace (no quote handling).
- `parseErrors(output)` — regex for error/Error/ERROR/failed/Failed/FAIL/warning:/Warning:/WARN, cap 500 chars per error line
- `extractSummary(output, cmdName)` — look for "Test Suites", "Tests", "Coverage", "ERRORS", "FAILURES" lines
- `runQualityGates(taskDir, projectRoot?)` — load commands from config, run typecheck → testUnit → lint (if configured), return `{ pass, errors[], summary }`. `projectRoot` defaults to `process.cwd()`.

**Details:**
- Default timeout: 5 minutes per command
- Command parsing: simple split on whitespace (no quote handling)
- Output: `verify.md` report with result + errors section

### Step 7: Validators (`src/validators.ts`) ~50 lines

Port from Kody-Engine `validators.ts` (45 lines).

- `validateTaskJson(content)` — parse JSON, check 5 required fields: `task_type`, `title`, `description`, `scope`, `risk_level`
- `validatePlanMd(content)` — non-empty (min 10 chars), has markdown h2+ section (`/^##\s+\w+/m`)
- `validateReviewMd(content)` — contains "pass" OR "fail" (case-insensitive)

### Step 8: Kody Utils (`src/kody-utils.ts`) ~40 lines

Port from Kody-Engine `kody-utils.ts` (36 lines).

- `getTaskDir(taskId)` — returns `.kody/tasks/${taskId}` relative to cwd
- `ensureTaskDir(taskId)` — creates directory recursively, returns path
- `loadTaskJson(taskDir)` — reads/parses `.kody/tasks/<id>/task.json`, returns null on parse error
- `TaskJson` interface: `{ id, title?, description?, profile?: "standard"|"lightweight"|"turbo", stages? }`

### Step 9: State Machine (`src/state-machine.ts`) ~350 lines

Port from Kody-Engine `state-machine-v2.ts` (552 lines). Uses `ctx.runner.run()` via AgentRunner interface.

**State management:**
- `loadState(taskId, taskDir)` — load `status.json`, validate taskId matches
- `writeState(state, taskDir)` — write with updated timestamp. **Called after EVERY stage** (success and failure)
- `initState(taskId)` — all stages set to `{ state: "pending", retries: 0 }`

**Resume logic (rerun mode):**
- If `state.state !== "running"`: reset to running, reset failed/running stages back to pending
- If `fromStage` set: skip all stages until matching name found (`startFrom` dual-flag pattern from Kody-Engine lines 429-441)
- Skip already-completed stages

**Stage dispatch:**
```
for each stage in STAGES:
  if completed → skip
  if agent + name === "review" → executeReviewWithFix(ctx, def)
  if agent (other) → executeAgentStage(ctx, def)
  if gate + name === "verify" → executeVerifyWithAutofix(ctx, def)
  if gate (other) → executeGateStage(ctx, def)
  if deterministic → executeDeterministicStage(ctx, def)
```

**executeAgentStage(ctx, def):**
- Call `ctx.runner.run(def.name, "<def.name>.md", def.timeout, ctx.taskId, ctx.taskDir, { outputFile: def.outputFile, modelTier: def.modelTier })`
- If output file produced, **validate output**:
  - taskify → `validateTaskJson(content)` — check 5 required fields
  - plan → `validatePlanMd(content)` — check non-empty + has h2 sections
  - review → `validateReviewMd(content)` — check contains "pass" or "fail"
- If validation fails, mark stage as failed with validation error
- Return StageResult based on AgentResult

**executeGateStage(ctx, def):**
- Call `runQualityGates(ctx.taskDir)`
- Write `verify.md` report (PASS/FAIL + errors list)
- Return completed if pass, failed if not

**executeVerifyWithAutofix(ctx, def):**
- Loop `attempt = 0` to `def.maxRetries ?? 2`:
  - Run gate stage
  - If pass → return completed
  - If fail + attempts remain:
    - Run `config.quality.lintFix` command (2min timeout, **silently ignore failures** — `.catch(() => {})`)
    - Run `config.quality.formatFix` command (2min timeout, **silently ignore failures**)
    - If `def.retryWithAgent`: run autofix agent via `ctx.runner.run("autofix", ...)`
    - Continue to next attempt
- After all attempts → return failed

**executeReviewWithFix(ctx, def):**
- Run review agent → produces review.md
- Read review.md content
- Check: `hasIssues = /\bfail\b/i.test(content) && !/pass/i.test(content)`
- If no issues → return review result
- If has issues → run review-fix agent → **re-run review agent** → return second review result

**executeShipStage(ctx, def):** (Phase 1: minimal, Phase 2: full git+github)
- Phase 1: write ship.md with "Ship stage skipped — run locally"
- Phase 2: see Step 18

**Lifecycle labels (Phase 2):**
- Pipeline start: `kody:planning` (or `kody:building` if rerun mode)
- Enter build stage: `kody:building`
- Enter review stage: `kody:review`
- Pipeline completed: `kody:done`
- Pipeline failed/timeout: `kody:failed`
- Atomic swap: remove ALL other lifecycle labels before adding new one

**Post-pipeline auto-learn (Phase 1):** ~40 lines
- If all stages completed, extract learnings from review.md/verify.md
- Append to `.kody/memory/conventions.md`

### Step 10: Entry Point (`src/entry.ts`) ~150 lines

Port from Kody-Engine `entry.ts` (226 lines).

**Commands:**
```
pnpm kody run    --task-id <id> [--issue-number <n>] [--feedback "<text>"] [--dry-run]
pnpm kody rerun  --task-id <id> --from <stage> [--feedback "<text>"]
pnpm kody status --task-id <id>
pnpm kody --help
```

**Flags:**
- `--task-id <id>` (required) — also reads from `TASK_ID` env var
- `--issue-number <n>` — GitHub issue number
- `--from <stage>` — resume from stage (rerun only)
- `--feedback "<text>"` — pass feedback to agents
- `--dry-run` — skip actual agent execution
- `--help` / `-h` — show usage and exit 0
- `--local` — skip GitHub API calls (auto-detected when `GITHUB_ACTIONS` is not set)

**CI mode detection:**
- When `GITHUB_ACTIONS=true`: read inputs from env vars (`TASK_ID`, `MODE`, `FROM_STAGE`, `ISSUE_NUMBER`, `FEEDBACK`, `DRY_RUN`)
- When local: parse `process.argv`
- Auto-set `local=true` when not in CI

**Flow:** parse args → load config → preflight checks → create AgentRunner → build PipelineContext → dispatch (run/rerun/status) → report results → exit

### Step 11: Preflight (`src/preflight.ts`) ~60 lines

Port from Kody-Engine `preflight.ts` (49 lines). Check in order:
1. `npx claude --version` — Claude Code CLI available (installed via `@anthropic-ai/claude-code`)
2. `git rev-parse --is-inside-work-tree` — git repo present
3. `pnpm --version` — pnpm available
4. `node --version` → parse major ≥ 18
5. `package.json` exists in cwd

All checks run; if any fail, throw with list of failures.

### Step 12: Prompt Templates (`prompts/`)

Port 6 prompts from Kody-Engine `src/engine/prompts/`, adapted for Claude Code tool-use.

**Structure:** Each prompt has YAML frontmatter (matching Kody-Engine pattern):
```markdown
---
name: <stage-name>
description: <what this agent does>
mode: primary
tools: [read, write, edit, bash, glob, grep]
---

<prompt body with {{TASK_CONTEXT}} placeholder>
```

#### `prompts/taskify.md` — print mode, ~50 lines
- **Input:** task.md (issue body)
- **Output contract:** JSON to stdout
  ```json
  { "task_type": "feature|bugfix|refactor|docs|chore",
    "title": "max 72 chars",
    "description": "what the task requires",
    "scope": ["file/module paths"],
    "risk_level": "low|medium|high" }
  ```
- **Include:** Risk level heuristics table (low: single file, no breaking changes; medium: multiple files, possible side effects; high: core logic, data migrations, security)
- **Instruction:** Output ONLY valid JSON, no fences, no extra text

#### `prompts/plan.md` — print mode, ~60 lines
- **Input:** task.md + task.json
- **Output contract:** Markdown with ordered steps
  ```markdown
  ## Step N: <description>
  **File:** <path>
  **Change:** <what to do>
  **Why:** <rationale>
  ```
- **TDD ordering:** tests before implementation
- **Each step:** completable in 2-5 minutes, exact file paths, verification

#### `prompts/build.md` — tool-use mode, ~70 lines
- **Input:** task.md + task.json + plan.md
- **Instruction:** Follow plan step by step. Use Read to examine code. Use Write/Edit for changes. Use Bash to run tests after each logical group. Do NOT commit — Kody handles git. Do NOT push.
- **Superpowers methodology:** Execute exactly, verify each step, document deviations

#### `prompts/review.md` — print mode, ~80 lines
- **Input:** task.md + plan.md + git diff (injected)
- **Output contract:** Markdown verdict
  ```markdown
  ## Verdict: PASS | FAIL
  ## Findings
  ### Critical
  ### Major
  ### Minor
  ```
- **Include:** Severity definitions (Critical: security/data loss/crash; Major: logic errors, missing edge cases; Minor: style, naming, perf)

#### `prompts/review-fix.md` — tool-use mode, ~50 lines
- **Input:** task.md + plan.md + review.md
- **Instruction:** Fix Critical and Major findings only (not Minor). Use Edit for surgical changes. Run tests to verify.

#### `prompts/autofix.md` — tool-use mode, ~50 lines
- **Input:** verify.md (error report)
- **Instruction:** Fix type errors, lint issues, test failures. Try `pnpm lint:fix` first. Run failing commands to verify.

### Step 13: Memory Loader (`src/memory.ts`) ~30 lines

- `readProjectMemory(memoryDir: string): string` — read all `*.md` from `.kody/memory/`, concat with `## <filename>` headers
- Returns empty string if directory doesn't exist (graceful)

### Step 14: Seed Memory Files

- `.kody/memory/conventions.md` — template with sections: Formatting, Testing, Imports, Patterns
- `.kody/memory/architecture.md` — template with sections: Overview, Key Modules, Data Flow

### Step 15: LiteLLM Config (`litellm-config.yaml`)

Rewrite with full agent mapping (see "LiteLLM: Unified Model Routing" section above). Include:
- 3 tier aliases (cheap/mid/strong) with Anthropic primary + OpenAI fallback
- 6 per-stage aliases (taskify/plan/build/autofix/review/review-fix)
- 3 future aliases (clarify/test-writer/reflect)
- `general_settings.master_key` from env var

### Step 16: Package & Config Updates

**package.json:**
- Add: `pino`, `pino-pretty`, `zod`, `slugify`
- Remove: `openai`
- Scripts: `"kody": "tsx src/entry.ts"`, `"typecheck": "tsc --noEmit"`

**Delete:** `src/llm-client.ts`, `src/prompts.ts`, `src/state-machine.ts`, `src/types.ts`, `src/definitions.ts`, `src/entry.ts`

**Create:** `kody.config.json` with defaults

**Update:** `.env.example` — add `ANTHROPIC_API_KEY`, `GH_TOKEN`, `LITELLM_MASTER_KEY`, `LITELLM_BASE_URL`

---

## Phase 2: Git + GitHub Integration

### Step 17: Git Utilities (`src/git-utils.ts`) ~250 lines

Port from Kody-Engine `git-utils.ts` (336 lines). All use `execFileSync`.

**Functions:**
- `deriveBranchName(issueNumber, title)` — slugify title (lowercase, remove non-alphanumeric, collapse spaces, limit 50 chars), format: `<issueNumber>-<slug>`
- `getDefaultBranch(cwd?)` — three-fallback: (1) `git symbolic-ref refs/remotes/origin/HEAD` (fast), (2) `git remote show origin` + parse HEAD branch (10s timeout), (3) fallback to `"dev"`
- `ensureFeatureBranch(issueNumber, title)` — check if already on feature branch (not in `["dev","main","master"]`), if yes return current. Otherwise: fetch origin, check remote then local for existing branch, checkout or create with tracking. Special: `git clean -fd` in GitHub Actions.
- `getCurrentBranch()` — `git branch --show-current`
- `commitAll(message)` — check `git status --porcelain` first (return if no changes), `git add -A`, `git commit --no-gpg-sign -m <msg>` with hook-safe env (HUSKY=0, SKIP_HOOKS=1). Return `{ success, hash, message }` where hash = first 7 chars of HEAD.
- `pushBranch()` — `git push -u origin HEAD`, 120s timeout, hook-safe env
- `getChangedFiles(baseBranch)` — `git diff --name-only origin/<base>...HEAD`, return string array
- `getDiff(baseBranch)` — `git diff origin/<base>...HEAD`, return text (empty string on error, not throw)

**Hook-safe env (cached):** `{ ...process.env, HUSKY: "0", SKIP_HOOKS: "1" }`

### Step 18: GitHub API (`src/github-api.ts`) ~180 lines

Port from Kody-Engine `github-api.ts` (246 lines). All use `gh` CLI via `execFileSync` with 30s timeout.

**Functions:**
- `getIssue(num)` — `gh issue view <num> --json body,title`, returns `{ body, title } | null`
- `setLabel(num, label)` — `gh issue edit <num> --add-label <label>`, log, don't throw
- `removeLabel(num, label)` — `gh issue edit <num> --remove-label <label>`, log, don't throw
- `postComment(num, body)` — `gh issue comment <num> --body-file -` with body via stdin. Uses `GH_PAT` env (preferred) or `GH_TOKEN` fallback. Log, don't throw.
- `createPR(head, base, title, body)` — `gh pr create --head <head> --base <base> --title <title> --body-file -` with body via stdin. Extract PR number from URL (`/\/pull\/(\d+)$/`). Return `{ number, url } | null`.
- `setLifecycleLabel(num, phase)` — validate phase in `["planning","building","review","done","failed"]`. Remove ALL other lifecycle labels (comma-separated `--remove-label`), then add new one. Atomic swap.
- `closeIssue(num, reason?)` — `gh issue close <num> --reason <reason>`, default "completed"

### Step 19: Wire Git + GitHub into State Machine

Update `state-machine.ts`:

**Before build stage:** `ensureFeatureBranch(issueNumber, taskTitle)` if `ctx.input.issueNumber` provided

**After build stage (if completed):** `commitAll("feat(<taskId>): implement task")`

**Ship stage (replaces Phase 1 stub):**
1. `getCurrentBranch()` → head branch name
2. `getDefaultBranch()` → base branch
3. `pushBranch()` with hook-safe env
4. Resolve owner/repo: first try `config.github.owner/repo`, fallback to parsing `git remote get-url origin` with regex `/github\.com[/:]([^/]+)\/([^/.]+)/`
5. Read `task.md` → derive PR title (first non-heading line, slice to `MAX_PR_TITLE_LENGTH` = 72 chars)
6. `createPR(head, base, title, body)` — body: "Generated by Kody pipeline\n\n---\n🤖 Generated by Kody"
7. If `ctx.input.issueNumber`: `postComment(issueNumber, "🎉 PR created: <url>")` — fire-and-forget (`.catch(() => {})`)
8. Write `ship.md` with PR URL

**Lifecycle labels:** Set at transitions (see Step 9)

**Local mode:** Skip all GitHub API calls when `ctx.input.local === true`

### Step 20: GitHub Actions Workflow (`.github/workflows/kody.yml`) ~250 lines

Start with `workflow_dispatch` trigger:

```yaml
on:
  workflow_dispatch:
    inputs:
      task_id: { required: true, type: string }
      mode: { type: string, default: "full" }         # full | rerun | status
      from_stage: { type: string, default: "" }        # rerun only
      issue_number: { type: string, default: "" }
      feedback: { type: string, default: "" }
      dry_run: { type: boolean, default: false }
      runner: { type: choice, options: [github-hosted, self-hosted], default: github-hosted }
      version: { type: string, default: "" }           # branch/tag/commit to overlay pipeline code
      complexity: { type: string, default: "" }        # 1-100 score override
      use_test_config: { type: boolean, default: false }  # use cheap models for testing

concurrency:
  group: kody-${{ github.event.inputs.task_id || 'default' }}
  cancel-in-progress: false

permissions:
  issues: write
  pull-requests: write
  contents: write
```

**Orchestrate job:**
1. Checkout (fetch-depth: 0, persist-credentials: true)
2. Setup pnpm + Node 22
3. Install dependencies
4. Install Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
5. Configure git identity
6. Set API keys from secrets (`ANTHROPIC_API_KEY`, `GH_TOKEN`)
7. Run: `pnpm kody` with env vars from inputs
8. Write pipeline summary to `$GITHUB_STEP_SUMMARY` (read status.json, format as table)
9. Upload `.kody/tasks/<id>/` artifacts (7-day retention)

---

## Phase 3: Full CI/CD

### Step 21: Parse Scripts (`src/ci/`)

Two TypeScript scripts run by the parse job in GitHub Actions. Port patterns from Kody-Engine.

#### `src/ci/parse-safety.ts` ~40 lines
- Validates comment trigger is safe to execute
- Checks `github.event.comment.author_association` against allowlist: `[COLLABORATOR, MEMBER, OWNER]`
- Reads from env: `COMMENT_AUTHOR_ASSOCIATION`, `COMMENT_BODY`
- Outputs to `$GITHUB_OUTPUT`: `valid=true|false`, `reason=<string>`
- Rejects: bot accounts, outside collaborators, unknown users

#### `src/ci/parse-inputs.ts` ~80 lines
- Parses `@kody` / `/kody` comment body into structured inputs
- Reads from env: `COMMENT_BODY`, `TRIGGER_TYPE`, `ISSUE_NUMBER`, plus dispatch inputs
- Parses comment syntax: `@kody [mode] [task-id] [--from <stage>] [--feedback "<text>"]`
- Outputs to `$GITHUB_OUTPUT`: `task_id`, `mode`, `from_stage`, `issue_number`, `feedback`, `valid`
- Handles both `workflow_dispatch` inputs and `issue_comment` parsing
- Default mode: `full`

### Step 22: GitHub App Token Generation

Add GitHub App authentication to the workflow for proper CI permissions.

**Why:** `GITHUB_TOKEN` has limited permissions. A GitHub App provides:
- Cross-repo access if needed
- `contents: write` + `pull-requests: write` + `issues: write`
- Token scoped to specific repos

**Workflow step:**
```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ vars.KODY_APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    repositories: ${{ github.event.repository.name }}
```

**Token usage:**
- Checkout: `token: ${{ steps.app-token.outputs.token }}`
- Git push: `GH_TOKEN=${{ steps.app-token.outputs.token }}`
- PR creation: uses same token via `gh` CLI

**Required secrets:** `APP_PRIVATE_KEY`
**Required vars:** `KODY_APP_ID`

### Step 23: Comment Trigger & Parse Job ~150 lines YAML

Add `issue_comment` trigger. Parse job uses scripts from Step 21.

```yaml
on:
  issue_comment:
    types: [created]
```

**Parse job steps:**
1. Sparse checkout (`src/ci/` only — saves bandwidth)
2. Setup Node
3. Check comment contains `@kody` or `/kody` (bash condition)
4. Run `parse-safety.ts` → validate author
5. Add "eyes" emoji reaction (`continue-on-error: true`)
6. Run `parse-inputs.ts` → extract structured inputs
7. Output all parsed variables for orchestrate job

**Job outputs:** `task_id`, `mode`, `from_stage`, `issue_number`, `feedback`, `valid`, `trigger_type`

### Step 24: PR Review Trigger ~30 lines YAML

```yaml
pull_request_review:
  types: [submitted]
```
- Only when `github.event.review.state == 'changes_requested'`
- Extract PR branch → derive task_id
- Run `kody rerun --from review-fix`
- Post comment: "Addressing review feedback..."

### Step 25: Error Notification Jobs ~60 lines YAML

**`notify-parse-error`:** If parse fails + trigger was issue_comment → post usage message
**`notify-orchestrate-error`:** If orchestrate fails → post failure with logs link (`$RUN_URL`), set `kody:failed` label

### Step 26: Smoke Test Job ~60 lines YAML

On push to main/dev (paths: `src/**`, `prompts/**`, `package.json`):
- `pnpm typecheck`
- `pnpm kody --help` (validates CLI loads, exits 0)
- Seed test task: `mkdir -p .kody/tasks/smoke-test && echo "Test task" > .kody/tasks/smoke-test/task.md`
- `pnpm kody run --task-id smoke-test --dry-run`
- Validate: `status.json` exists and has expected structure
- Cleanup: `rm -rf .kody/tasks/smoke-test`

### Step 27: Concurrency & Permissions

**Concurrency group** (fallback chain matching Kody-Engine):
```yaml
concurrency:
  group: kody-${{ github.event.inputs.task_id || github.event.issue.number || github.event.pull_request.number || github.sha }}
  cancel-in-progress: false
```

**Permissions:**
```yaml
permissions:
  issues: write
  pull-requests: write
  contents: write
  id-token: write  # For GitHub App OIDC
```

---

## Phase 4: Brain / Engine Separation

Separate **cognition** (reasoning, analysis, planning, review) from **execution** (code changes, git, GitHub). The Brain is a **standalone, portable service** deployed on a dedicated VPS. The Engine stays in Kody-Engine-Lite (GitHub Actions / local). They communicate via HTTP API.

### Architecture

```
┌─────────────────────────────────────┐     ┌──────────────────────────────────┐
│  VPS (dedicated Brain server)       │     │  GitHub Actions / Local          │
│                                     │     │                                  │
│  Kody-Brain (HTTP service)          │     │  Kody-Engine (orchestrator)      │
│  ├── POST /run/:stage               │◄────│  ├── state-machine.ts            │
│  ├── GET  /health                   │────►│  ├── agent-runner.ts             │
│  │                                  │     │  │   ├── BrainRunner (HTTP)      │
│  │  Internally:                     │     │  │   └── EngineRunner (local)    │
│  │  ├── Claude Code (read-only)     │     │  │                               │
│  │  ├── LiteLLM proxy              │     │  │  Claude Code (read+write)     │
│  │  ├── Prompt templates            │     │  │  ├── build                    │
│  │  ├── Project memory              │     │  │  ├── autofix                  │
│  │  └── Model routing               │     │  │  └── review-fix              │
│  │                                  │     │  │                               │
│  │  Stages:                         │     │  │  Stages:                      │
│  │  ├── taskify → task.json         │     │  │  ├── build → code changes     │
│  │  ├── plan → plan.md              │     │  │  ├── verify → quality gates   │
│  │  └── review → review.md          │     │  │  ├── autofix → fix files      │
│  │                                  │     │  │  ├── review-fix → fix files   │
│  │  Access: READ-ONLY to code       │     │  │  └── ship → git push + PR     │
│  │  (receives code context via API)  │     │  │                               │
│  │  NO write access to target repo  │     │  │  Access: READ + WRITE          │
└─────────────────────────────────────┘     └──────────────────────────────────┘
```

**Key properties of Kody-Brain:**
- **Portable:** Runs on any VPS with Node.js + Claude Code CLI + LiteLLM
- **Stateless per request:** Receives all context (task artifacts, code snippets, memory) in the API request body
- **Read-only:** Never writes to the target repo. Receives code context, returns text artifacts.
- **Own LiteLLM instance:** Brain has its own model routing — can use different models/providers than Engine
- **Own memory:** `.kody/memory/` files are synced to Brain server or passed per request
- **Separately deployable:** Updates to Brain don't require redeploying Engine, and vice versa

### Step 28: Brain API Contract

**`POST /run/:stage`** — Execute a brain stage (taskify, plan, review)

Request:
```json
{
  "taskId": "260325-feature",
  "stage": "taskify",
  "context": {
    "taskMd": "... issue body ...",
    "taskJson": null,
    "planMd": null,
    "specMd": null,
    "diff": null,
    "memory": ["## conventions.md\n...", "## architecture.md\n..."]
  },
  "config": {
    "modelTier": "cheap",
    "timeout": 180000
  }
}
```

Response:
```json
{
  "outcome": "completed",
  "output": "{ \"task_type\": \"feature\", ... }",
  "error": null
}
```

**`GET /health`** — Health check (returns 200 if Brain + LiteLLM proxy are running)

**Stage → context mapping:**
| Stage | Receives | Returns |
|-------|----------|---------|
| taskify | taskMd | task.json (as string) |
| plan | taskMd + taskJson | plan.md (as string) |
| review | taskMd + planMd + diff | review.md (as string) |

### Step 29: Add `runner` field to StageDefinition

Update `src/types.ts`:
```typescript
interface StageDefinition {
  // ... existing fields
  runner: "brain" | "engine"  // Which runner to use
}
```

Update `src/definitions.ts`:

| Stage | Type | Runner | Location | Output |
|-------|------|--------|----------|--------|
| taskify | agent | **brain** | VPS (HTTP) | task.json |
| plan | agent | **brain** | VPS (HTTP) | plan.md |
| build | agent | **engine** | local (Claude Code) | files modified |
| verify | gate | — | local (Kody commands) | verify.md |
| review | agent | **brain** | VPS (HTTP) | review.md |
| review-fix | agent | **engine** | local (Claude Code) | files modified |
| autofix | agent | **engine** | local (Claude Code) | files modified |
| ship | deterministic | — | local (git/gh) | ship.md |

### Step 30: BrainRunner Implementation (`src/agent-runner.ts`)

Add a new factory alongside the existing Claude Code runner:

```typescript
// HTTP-based brain runner — calls remote Brain server
function createBrainRunner(config: KodyConfig): AgentRunner {
  const brainUrl = config.agent.brainUrl  // e.g., "https://brain.kody.dev"

  return {
    async run(stageName, promptPath, timeout, taskId, taskDir, options) {
      // 1. Read task artifacts from local .kody/tasks/<id>/
      // 2. Read .kody/memory/*.md
      // 3. POST to brain server: /run/<stageName>
      //    Body: { taskId, stage, context: { taskMd, taskJson, planMd, diff, memory }, config: { modelTier, timeout } }
      // 4. Wait for response (with timeout)
      // 5. Return AgentResult { outcome, output, error }
    },
    async healthCheck() {
      // GET brainUrl/health → 200 OK
    }
  }
}

// Local engine runner — unchanged from Phase 1-3
function createEngineRunner(config: KodyConfig): AgentRunner {
  // Same as existing createClaudeCodeRunner — spawns Claude Code locally
}
```

### Step 31: Update Config, PipelineContext, State Machine

**`kody.config.json` addition:**
```json
{
  "agent": {
    "brainUrl": "https://brain.kody.dev",
    "runner": "claude-code",
    "modelMap": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" }
  }
}
```

**`src/types.ts` — PipelineContext:**
```typescript
interface PipelineContext {
  // ... existing fields
  brainRunner: AgentRunner   // HTTP calls to Brain VPS
  engineRunner: AgentRunner  // Local Claude Code
}
```

**`src/state-machine.ts` — stage dispatch:**
```typescript
const runner = def.runner === "brain" ? ctx.brainRunner : ctx.engineRunner
const result = await runner.run(def.name, ...)
```

**`src/entry.ts` — create both:**
```typescript
const brainRunner = createBrainRunner(config)
const engineRunner = createEngineRunner(config)
const ctx: PipelineContext = { ..., brainRunner, engineRunner }
```

### Step 32: Brain Server Implementation (separate repo)

The Brain server lives at `/Users/aguy/projects/brain/brain-server/`. It is a separate project with its own:

- **HTTP server** (Express or Fastify) — handles `/run/:stage` and `/health`
- **Claude Code integration** — spawns Claude Code with read-only tools (`Read`, `Glob`, `Grep` only)
- **LiteLLM proxy** — its own instance for model routing
- **Prompt templates** — same prompts as Kody-Engine-Lite `prompts/` for brain stages (taskify.md, plan.md, review.md)
- **Memory files** — either synced from target repo or received per request
- **No git/GitHub** — Brain never interacts with git or GitHub directly

**Brain server receives code context in the request** — it does NOT clone or checkout the target repo. The Engine (Kody-Engine-Lite) reads the relevant code/diff locally and sends it to Brain in the API request body. This keeps Brain truly portable and stateless.

**Deployment:** Docker container on VPS. Environment: `ANTHROPIC_API_KEY`, `LITELLM_MASTER_KEY`, Brain-specific config.

**This step is implementation in the brain-server repo, not in Kody-Engine-Lite.**

### Phase 4 Impact on Kody-Engine-Lite

| File | Change | Lines |
|------|--------|-------|
| `src/types.ts` | Add `runner` to StageDefinition, dual runners in PipelineContext | +15 |
| `src/definitions.ts` | Add `runner: "brain"/"engine"` to each stage | +7 |
| `src/agent-runner.ts` | Add `createBrainRunner` (HTTP client), rename existing to `createEngineRunner` | +60 |
| `src/config.ts` | Add `brainUrl` to KodyConfig | +5 |
| `src/state-machine.ts` | Select runner via `def.runner` | +5 |
| `src/entry.ts` | Create both runners, preflight health check on brain | +10 |
| `src/preflight.ts` | Add brain server health check | +10 |
| **Total Kody-Engine-Lite changes** | | **~112 lines** |

**Separate Brain server repo:** ~300-500 lines (HTTP server, Claude Code integration, prompt loading)

---

## Error Recovery Strategy

| Failure | Recovery | Auto? |
|---------|----------|-------|
| Build exit non-0 | Pipeline stops. `rerun --from build` | No |
| Build timeout | SIGTERM → 5s → SIGKILL. `rerun --from build` | No |
| Verify fails (attempt < max) | Run lintFix + formatFix + autofix agent → retry | Yes |
| Verify fails (max attempts) | Pipeline stops. `rerun --from verify` | No |
| Review verdict: FAIL | Run review-fix → re-run review | Yes |
| Review-fix + re-review still FAIL | Pipeline stops. `rerun --from review` | No |
| Agent crash (unhandled) | Caught by try/catch, written to status.json | No |
| Ship fails (push/PR) | Pipeline stops. `rerun --from ship` | No |
| CI job timeout (120min) | `notify-orchestrate-error` posts comment | No |
| CI job crash | Artifacts uploaded regardless. `notify-orchestrate-error` | No |

---

## File Summary

### DELETE (current Lite demo)
`src/llm-client.ts`, `src/prompts.ts`, `src/state-machine.ts`, `src/types.ts`, `src/definitions.ts`, `src/entry.ts`

### KEEP
`package.json`, `tsconfig.json`, `.env.example`, `.gitignore`

### CREATE

| File | Phase | ~Lines | Reference |
|------|-------|--------|-----------|
| `src/types.ts` | 1 | 90 | KE types.ts + AgentRunner |
| `src/definitions.ts` | 1 | 70 | KE definitions.ts + modelTier |
| `src/logger.ts` | 1 | 70 | KE logger.ts |
| `src/config.ts` | 1 | 150 | KE config.ts (zod) |
| `src/agent-runner.ts` | 1 | 120 | KE agent-runner-v2.ts (thin wrapper) |
| `src/context.ts` | 1 | 80 | NEW — prompt assembly, task context injection |
| `src/verify-runner.ts` | 1 | 150 | KE verify-runner.ts |
| `src/validators.ts` | 1 | 50 | KE validators.ts |
| `src/kody-utils.ts` | 1 | 40 | KE kody-utils.ts |
| `src/state-machine.ts` | 1 | 350 | KE state-machine-v2.ts |
| `src/entry.ts` | 1 | 150 | KE entry.ts |
| `src/preflight.ts` | 1 | 60 | KE preflight.ts |
| `src/memory.ts` | 1 | 30 | NEW |
| `prompts/taskify.md` | 1 | 50 | KE prompts/ + frontmatter |
| `prompts/plan.md` | 1 | 60 | KE prompts/ |
| `prompts/build.md` | 1 | 70 | NEW (tool-use) |
| `prompts/review.md` | 1 | 80 | KE prompts/ + severity defs |
| `prompts/review-fix.md` | 1 | 50 | NEW (tool-use) |
| `prompts/autofix.md` | 1 | 50 | KE prompts/ |
| `litellm-config.yaml` | 1 | 80 | NEW (full agent mapping) |
| `.kody/memory/conventions.md` | 1 | 15 | NEW |
| `.kody/memory/architecture.md` | 1 | 15 | NEW |
| `kody.config.json` | 1 | 25 | NEW |
| `src/git-utils.ts` | 2 | 250 | KE git-utils.ts |
| `src/github-api.ts` | 2 | 180 | KE github-api.ts |
| `.github/workflows/kody.yml` | 2-3 | 500 | KE kody.yml |
| `src/ci/parse-safety.ts` | 3 | 40 | KE parse-safety pattern |
| `src/ci/parse-inputs.ts` | 3 | 80 | KE parse-inputs pattern |

### Line Count

| Phase | TS | Prompts/Config | YAML | Total |
|-------|-----|---------------|------|-------|
| Phase 1: Skeleton | ~1,430 | ~495 | — | ~1,925 |
| Phase 2: Git + GitHub + workflow_dispatch | +430 | — | ~250 | ~2,605 |
| Phase 3: Full CI/CD (triggers, parse, App auth, smoke) | +120 | — | +300 | ~3,025 |
| Phase 4: Brain/Engine split | +112 | — | — | ~3,137 |
| Phase 4: Brain server (separate repo) | ~400 | ~150 | — | ~550 (separate) |

---

## Verification

### Phase 1
```bash
pnpm typecheck                                    # All files compile
pnpm kody --help                                  # Shows usage
pnpm kody status --task-id test                   # Preflight passes
pnpm kody run --task-id 260325-test-sum-fn        # Full pipeline (needs claude CLI + ANTHROPIC_API_KEY)
cat .kody/tasks/260325-test-sum-fn/status.json         # All stages completed
ls .kody/tasks/260325-test-sum-fn/                     # task.json, plan.md, review.md, verify.md, ship.md
pnpm kody rerun --task-id 260325-test-sum-fn --from review  # Resume works
grep -r "claude" src/state-machine.ts             # Returns nothing (decoupled)
cat litellm-config.yaml                           # All agent aliases present
```

### Phase 2
```bash
pnpm kody run --task-id 260325-test --issue-number 1  # Feature branch + PR + comment
git log --oneline -3                                    # Commit present
pnpm kody rerun --task-id 260325-test --from review    # Resume with git
# GitHub Actions: workflow_dispatch → orchestrate runs → artifacts uploaded
```

### Phase 3: Full CI/CD
```bash
# 1. Parse scripts work
pnpm tsx src/ci/parse-inputs.ts  # With mock env vars → outputs parsed inputs
pnpm tsx src/ci/parse-safety.ts  # With mock env vars → outputs valid/reason

# 2. Comment trigger: @kody full 260325-feature on issue
#    Verify: parse job validates author → parse-inputs extracts vars → orchestrate runs → PR created

# 3. Bad command: @kody invalid → notify-parse-error posts usage message

# 4. PR review trigger: request changes on PR → review-fix auto-triggered

# 5. Smoke test: push to main/dev → typecheck + CLI validation + dry-run

# 6. GitHub App token: verify App token used for checkout and git push (not GITHUB_TOKEN)

# 7. Concurrency: two @kody commands for same task → second waits for first
```

### Phase 4: Brain/Engine split
```bash
# 1. Brain server health check
curl https://brain.kody.dev/health  # Returns 200

# 2. Brain server runs stage directly
curl -X POST https://brain.kody.dev/run/taskify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"test","stage":"taskify","context":{"taskMd":"Add a sum function"},"config":{"modelTier":"cheap","timeout":180000}}'
# Returns: { "outcome": "completed", "output": "{...task.json...}" }

# 3. Full pipeline with Brain runner
BRAIN_URL=https://brain.kody.dev pnpm kody run --task-id 260325-brain-test
# Brain stages (taskify, plan, review) → HTTP to VPS
# Engine stages (build, autofix, review-fix) → local Claude Code

# 4. Verify decoupling
grep -r "brainRunner\|engineRunner" src/state-machine.ts  # Both referenced
grep -r "fetch.*brain" src/agent-runner.ts                # HTTP calls present

# 5. Brain server is independent — can restart without affecting Engine
# 6. Engine works without Brain — fallback to local Claude Code if brainUrl not set
```
