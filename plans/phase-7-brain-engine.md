# Phase 7 — Brain / Engine Separation

## Goal
Separate cognition (reasoning, analysis, planning, review) from execution (code changes, git, GitHub). The Brain is a **standalone, portable HTTP service** deployed on a dedicated VPS. The Engine stays in Kody-Engine-Lite.

## Prerequisite
Phase 6 complete — full GitHub-integrated SDLC pipeline works.

## Architecture

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
│  │  Access: READ-ONLY               │     │  │  └── ship → git push + PR     │
│  │  (receives context via API)       │     │  │                               │
│  │  NO write access to target repo  │     │  │  Access: READ + WRITE          │
└─────────────────────────────────────┘     └──────────────────────────────────┘
```

## What gets built

### Kody-Engine-Lite changes

| File | Change | ~Lines |
|------|--------|--------|
| `src/types.ts` | Add `runner: "brain" \| "engine"` to StageDefinition, dual runners in PipelineContext | +15 |
| `src/definitions.ts` | Add `runner` field to each stage | +7 |
| `src/agent-runner.ts` | Add `createBrainRunner(config)` — HTTP client; rename existing to `createEngineRunner` | +60 |
| `src/config.ts` | Add `brainUrl` to KodyConfig | +5 |
| `src/state-machine.ts` | Select runner via `def.runner === "brain" ? ctx.brainRunner : ctx.engineRunner` | +5 |
| `src/entry.ts` | Create both runners, preflight health check on brain | +10 |
| `src/preflight.ts` | Add brain server health check | +10 |
| **Total** | | **~112** |

### Brain server (separate repo: `/Users/aguy/projects/brain/brain-server/`)

| File | ~Lines | Purpose |
|------|--------|---------|
| `src/server.ts` | ~100 | HTTP server (Express/Fastify): `/run/:stage`, `/health` |
| `src/runner.ts` | ~80 | Spawn Claude Code with read-only tools only |
| `src/prompts/` | ~200 | Copy of taskify.md, plan.md, review.md |
| `litellm-config.yaml` | ~40 | Brain's own model routing |
| `Dockerfile` | ~20 | Docker deployment |
| **Total** | **~440** | |

## Brain API contract

### `POST /run/:stage`

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

### `GET /health`
Returns 200 if Brain + LiteLLM proxy are running.

### Stage → context mapping

| Stage | Receives | Returns |
|-------|----------|---------|
| taskify | taskMd | task.json (as string) |
| plan | taskMd + taskJson | plan.md (as string) |
| review | taskMd + planMd + diff | review.md (as string) |

## Stage → runner mapping

| Stage | Runner | Location | Permissions |
|-------|--------|----------|-------------|
| taskify | **brain** | VPS (HTTP) | read-only |
| plan | **brain** | VPS (HTTP) | read-only |
| build | **engine** | local (Claude Code) | read+write |
| verify | — | local (Kody commands) | — |
| review | **brain** | VPS (HTTP) | read-only |
| review-fix | **engine** | local (Claude Code) | read+write |
| autofix | **engine** | local (Claude Code) | read+write |
| ship | — | local (git/gh) | — |

## BrainRunner implementation

```typescript
function createBrainRunner(config: KodyConfig): AgentRunner {
  const brainUrl = config.agent.brainUrl  // "https://brain.kody.dev"
  return {
    async run(stageName, prompt, model, timeout, taskDir, options) {
      // 1. Read task artifacts from .kody/tasks/<id>/
      // 2. Read .kody/memory/*.md
      // 3. POST brainUrl/run/<stageName>
      //    Body: { taskId, stage, context: { taskMd, taskJson, planMd, diff, memory }, config }
      // 4. Wait for response (with timeout via AbortController)
      // 5. Write output to taskDir/<outputFile> if provided
      // 6. Return AgentResult
    },
    async healthCheck() {
      // GET brainUrl/health → 200
    }
  }
}
```

## Brain server key properties
- **Portable:** Node.js + Claude Code CLI + LiteLLM on any VPS
- **Stateless:** All context received per request — no repo checkout, no local state
- **Read-only:** Claude Code spawned with `--allowedTools "Read,Glob,Grep"` only — no Write, Edit, Bash
- **Own LiteLLM:** Independent model routing from Engine
- **Own memory:** Received per request in `context.memory[]`
- **Separately deployable:** Update Brain without redeploying Engine

## Config update

```json
{
  "agent": {
    "brainUrl": "https://brain.kody.dev",
    "runner": "claude-code",
    "modelMap": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" }
  }
}
```

## Fallback
If `brainUrl` is not set in config, brain stages fall back to local Claude Code runner (same as Phase 1-6 behavior). This ensures backward compatibility.

## Deployment (Brain server)
```bash
# Build
docker build -t kody-brain .

# Run
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=... \
  -e LITELLM_MASTER_KEY=... \
  kody-brain

# Health check
curl https://brain.kody.dev/health
```

## Success criteria
```bash
# 1. Brain server health
curl https://brain.kody.dev/health  # 200

# 2. Brain runs stage directly
curl -X POST https://brain.kody.dev/run/taskify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"test","stage":"taskify","context":{"taskMd":"Add a sum function"},"config":{"modelTier":"cheap","timeout":180000}}'

# 3. Full pipeline with Brain
BRAIN_URL=https://brain.kody.dev pnpm kody run --task-id 260325-brain --task "Add divide"
# Brain stages (taskify, plan, review) → HTTP to VPS
# Engine stages (build, autofix, review-fix) → local Claude Code

# 4. Verify decoupling
grep -r "brainRunner\|engineRunner" src/state-machine.ts  # Both used

# 5. Fallback works — unset BRAIN_URL, pipeline still works locally

# 6. Brain server is independent — restart without affecting Engine
```
