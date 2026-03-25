# Phase 2 — Multi-Stage Pipeline

## Goal
Add stage orchestration: run multiple stages sequentially with artifacts passed between them.

## Prerequisite
Phase 1 complete — single-stage CLI works.

## What gets built

### New files

| File | ~Lines | Purpose |
|------|--------|---------|
| `src/definitions.ts` | ~70 | Stage definitions array with `getStage()` helper |
| `src/context.ts` | ~80 | Prompt assembly: read prompt file, inject task context, replace `{{TASK_CONTEXT}}` |
| `src/state-machine.ts` | ~150 | Linear stage loop — iterate STAGES, call runner per stage, write artifacts |
| `src/validators.ts` | ~50 | Validate taskify JSON, plan markdown, review markdown |
| `prompts/taskify.md` | ~50 | Classify task → task.json |
| `prompts/plan.md` | ~60 | Create implementation plan → plan.md |
| `prompts/review.md` | ~80 | Code review → review.md |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Add `StageName`, `StageType`, `StageDefinition`, `StageResult`, `PipelineContext` |
| `src/entry.ts` | Replace single-stage call with `runPipeline()` from state-machine |

## Architecture (Phase 2)

```
CLI (entry.ts)
  → parse --task-id
  → ensureTaskDir()
  → runPipeline(ctx)
      → for each stage in [taskify, plan, build, review]:
          → context.ts: build prompt (read artifacts + inject context)
          → runner.run(stage, prompt, model, timeout, taskDir)
          → write output artifact
          → validate output
```

## Stages (Phase 2 — simplified, no verify/ship yet)

| Stage | Type | Model | Timeout | Output | Mode |
|-------|------|-------|---------|--------|------|
| taskify | agent | cheap (haiku) | 3m | task.json | print — capture stdout |
| plan | agent | mid (sonnet) | 5m | plan.md | print — capture stdout |
| build | agent | strong (opus) | 20m | — | tool-use — agent writes files |
| review | agent | mid (sonnet) | 5m | review.md | print — capture stdout |

No verify, review-fix, autofix, or ship yet — those come in Phase 3.

## Implementation details

### `src/definitions.ts`
```typescript
const STAGES: StageDefinition[] = [
  { name: "taskify", type: "agent", modelTier: "cheap", timeout: 180_000, maxRetries: 0, outputFile: "task.json" },
  { name: "plan",    type: "agent", modelTier: "mid",   timeout: 300_000, maxRetries: 0, outputFile: "plan.md" },
  { name: "build",   type: "agent", modelTier: "strong", timeout: 1_200_000, maxRetries: 0 },
  { name: "review",  type: "agent", modelTier: "mid",   timeout: 300_000, maxRetries: 0, outputFile: "review.md" },
]
function getStage(name: string): StageDefinition | undefined
```

### `src/context.ts` — Prompt assembly (NOT in agent-runner)
- `readPromptFile(stageName)` — read `prompts/<stage>.md`, resolve via `import.meta.url`
- `injectTaskContext(prompt, taskId, taskDir)` — read task.md, task.json (extract `issue.title`, `issue.number`), plan.md (first 1500 chars), spec.md (first 2000 chars). Replace `{{TASK_CONTEXT}}`.
- `resolveModel(modelTier, config)` — map tier to model name: `cheap→haiku`, `mid→sonnet`, `strong→opus`

### `src/state-machine.ts` — Linear pipeline
```typescript
async function runPipeline(ctx: PipelineContext): Promise<void> {
  for (const def of STAGES) {
    const prompt = readPromptFile(def.name)
    const context = injectTaskContext(prompt, ctx.taskId, ctx.taskDir)
    const model = resolveModel(def.modelTier, config)
    const result = await ctx.runner.run(def.name, context, model, def.timeout, ctx.taskDir, { outputFile: def.outputFile })

    if (result.outcome !== "completed") {
      logger.error(`Stage ${def.name} failed: ${result.error}`)
      break
    }

    // Write output for print-mode stages
    if (def.outputFile && result.output) {
      fs.writeFileSync(path.join(ctx.taskDir, def.outputFile), result.output)
    }

    // Validate output
    if (def.outputFile) {
      const content = fs.readFileSync(path.join(ctx.taskDir, def.outputFile), "utf-8")
      if (def.name === "taskify") validateTaskJson(content)
      if (def.name === "plan") validatePlanMd(content)
      if (def.name === "review") validateReviewMd(content)
    }
  }
}
```

### `src/validators.ts`
- `validateTaskJson(content)` — parse JSON, check fields: `task_type`, `title`, `description`, `scope`, `risk_level`
- `validatePlanMd(content)` — non-empty (min 10 chars), has h2 section (`/^##\s+\w+/m`)
- `validateReviewMd(content)` — contains "pass" or "fail" (case-insensitive)

### Prompt templates

**`prompts/taskify.md`** — print mode
- Input: task.md
- Output: JSON with 5 fields (task_type, title, description, scope, risk_level)
- Include risk level heuristics table
- Instruction: output ONLY valid JSON, no fences

**`prompts/plan.md`** — print mode
- Input: task.md + task.json
- Output: Markdown with `## Step N` sections (File, Change, Why)
- TDD ordering: tests before implementation

**`prompts/review.md`** — print mode
- Input: task.md + plan.md + (agent reads diff via Bash)
- Output: `## Verdict: PASS | FAIL` + Findings (Critical/Major/Minor)
- Include severity definitions

### `src/entry.ts` updates
- Change `--task` to `--task-id` (required)
- Add `--task` for inline task description (writes task.md)
- Replace single runner.run() with `runPipeline(ctx)`
- Report per-stage results

## What is NOT in Phase 2
- No state persistence (no status.json, no resume)
- No verify gate (quality commands)
- No autofix loop
- No review-fix loop
- No config system (hardcoded model map)
- No memory system
- No GitHub/git integration

## Success criteria
```bash
pnpm kody run --task-id 260325-sum-fn --task "Create a sum function with tests"
# Runs: taskify → plan → build → review
ls .tasks/260325-sum-fn/
# Expected: task.md, task.json, plan.md, review.md
cat .tasks/260325-sum-fn/task.json   # Valid JSON with 5 fields
cat .tasks/260325-sum-fn/review.md   # Contains PASS or FAIL verdict
```
