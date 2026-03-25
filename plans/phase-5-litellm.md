# Phase 5 — LiteLLM Integration

## Goal
Add model routing via LiteLLM proxy. Replace hardcoded model names with LiteLLM aliases. Enable per-stage model selection, provider fallback, and cost tracking.

## Prerequisite
Phase 4 complete — Superpowers prompts and memory system work.

## What gets built

### New files

| File | ~Lines | Purpose |
|------|--------|---------|
| `litellm-config.yaml` | ~80 | Full agent-to-model routing config (replaces opencode.json) |

### Modified files

| File | Change |
|------|--------|
| `src/config.ts` | Add `litellmUrl`, `usePerStageRouting` to KodyConfig.agent |
| `src/context.ts` | Update `resolveModel()` — support LiteLLM aliases and per-stage routing |
| `.env.example` | Add `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY`, `OPENAI_API_KEY` |
| `kody.config.json` | Add LiteLLM config options |

## LiteLLM config — unified model routing

Replaces opencode.json's 21 fragmented agent→model mappings.

```yaml
model_list:
  # ── Tier aliases ──
  - model_name: cheap
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: cheap  # fallback
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

  - model_name: mid
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: mid  # fallback
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  - model_name: strong
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: strong  # fallback
    litellm_params:
      model: openai/gpt-4
      api_key: os.environ/OPENAI_API_KEY

  # ── Per-stage aliases ──
  - model_name: taskify
    litellm_params: { model: anthropic/claude-haiku-4-5, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: plan
    litellm_params: { model: anthropic/claude-sonnet-4-6, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: build
    litellm_params: { model: anthropic/claude-opus-4-6, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: autofix
    litellm_params: { model: anthropic/claude-sonnet-4-6, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: review
    litellm_params: { model: anthropic/claude-opus-4-6, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: review-fix
    litellm_params: { model: anthropic/claude-opus-4-6, api_key: os.environ/ANTHROPIC_API_KEY }

  # ── Future aliases ──
  - model_name: clarify
    litellm_params: { model: openai/gpt-4o, api_key: os.environ/OPENAI_API_KEY }
  - model_name: test-writer
    litellm_params: { model: anthropic/claude-sonnet-4-6, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: reflect
    litellm_params: { model: anthropic/claude-haiku-4-5, api_key: os.environ/ANTHROPIC_API_KEY }

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

## How it integrates

### Without LiteLLM (Phase 1-4 mode, still works)
```json
{ "agent": { "modelMap": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" } } }
```
`resolveModel("cheap")` → `"haiku"` → passed to `claude --model haiku`

### With LiteLLM proxy
```json
{ "agent": { "modelMap": { "cheap": "cheap", "mid": "mid", "strong": "strong" }, "litellmUrl": "http://localhost:4000" } }
```
`resolveModel("cheap")` → `"cheap"` → Claude Code routes through LiteLLM proxy
Set `ANTHROPIC_BASE_URL=http://localhost:4000` so Claude Code sends requests to LiteLLM.

### Per-stage routing (advanced)
```json
{ "agent": { "usePerStageRouting": true, "litellmUrl": "http://localhost:4000" } }
```
`resolveModel("build")` → `"build"` → LiteLLM resolves to `claude-opus-4-6`

### `resolveModel()` update in `src/context.ts`
```typescript
function resolveModel(stageName: string, modelTier: string, config: KodyConfig): string {
  if (config.agent.usePerStageRouting) {
    return stageName  // LiteLLM alias = stage name
  }
  return config.agent.modelMap[modelTier]  // tier → model name or LiteLLM alias
}
```

## Running LiteLLM proxy

```bash
# Install
pip install litellm[proxy]

# Start proxy
litellm --config litellm-config.yaml --port 4000

# Test
curl http://localhost:4000/health
```

## Environment variables added

| Var | Purpose |
|-----|---------|
| `LITELLM_BASE_URL` | LiteLLM proxy URL (e.g., `http://localhost:4000`) |
| `LITELLM_MASTER_KEY` | Auth key for LiteLLM proxy |
| `OPENAI_API_KEY` | For OpenAI fallback models in LiteLLM |

## What is NOT in Phase 5
- No GitHub integration
- No git operations
- No CI/CD workflow
- No Brain/Engine split
- No cost tracking dashboard (LiteLLM logs costs, but no UI)

## Success criteria
```bash
# LiteLLM proxy runs
litellm --config litellm-config.yaml --port 4000 &
curl http://localhost:4000/health  # 200 OK

# Pipeline uses LiteLLM routing
LITELLM_BASE_URL=http://localhost:4000 pnpm kody run --task-id 260325-litellm --task "Add a divide function"
# Verify: LiteLLM proxy logs show requests routed to correct models per stage

# Per-stage routing works
# Update kody.config.json with usePerStageRouting: true
pnpm kody run --task-id 260325-perstage --task "Add error handling"
# Verify: taskify→haiku, plan→sonnet, build→opus in LiteLLM logs

# Fallback works — disable Anthropic key, verify OpenAI fallback activates

# Without LiteLLM still works (backward compatible)
unset LITELLM_BASE_URL
pnpm kody run --task-id 260325-nolitellm --task "Simple task"
# Works with direct model names
```
