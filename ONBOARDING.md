# Kody-Engine-Lite — Developer Onboarding

## What is this?

An autonomous SDLC pipeline as an npm package. Users comment `@kody` on a GitHub issue → 7-stage pipeline runs → PR created. No human intervention needed.

## Architecture

```
@kody on GitHub issue
  → GitHub Actions workflow
    → kody-engine-lite CLI
      → pipeline.ts (7 stages)
        → Claude Code (agent with tool use)
          → PR created
```

**Design principles:**
- **Engine is generic** — zero knowledge of specific tools or skills in source code. Tools are declared in `.kody/tools.yml` by the user. Skills come exclusively from [skills.sh](https://skills.sh) and are loaded natively by Claude Code. The engine never ships, hardcodes, or injects skill content.
- Orchestrator is dumb — runs stages in order, no reasoning
- Agent runner is a thin subprocess wrapper — spawn, pipe, timeout, return
- All intelligence lives in Claude Code + prompt templates
- Any model works via LiteLLM proxy (tested: MiniMax with full tool use)

## Key Files

| File | What it does |
|------|-------------|
| `src/pipeline.ts` | The heart — pipeline loop, stage dispatch, state management, lock |
| `src/entry.ts` | CLI — run/rerun/fix/status, task-id resolution, issue fetching |
| `src/agent-runner.ts` | Spawns `claude --print`, pipes prompt, collects output |
| `src/context.ts` | Builds prompts — reads memory, injects task context with tiered loading |
| `src/context-tiers.ts` | L0/L1/L2 tiered context system for token optimization |
| `src/config.ts` | Config loader + LiteLLM helpers (`anyStageNeedsProxy`, `parseProviderModel`, `getLitellmUrl`) |
| `src/bin/cli.ts` | Package entry — init, bootstrap, version |
| `templates/kody.yml` | GitHub Actions workflow installed in target repos |
| `prompts/*.md` | Stage instructions for Claude Code |

## Dev Commands

```bash
pnpm install          # Install
pnpm typecheck        # Type check
pnpm test             # 416 tests across 41 files
pnpm build            # Build package (tsup → dist/)
pnpm kody run --task "..." --cwd /path  # Dev mode
```

## Testing

Always test against a separate target repo with `--cwd` to avoid contaminating source files.

```bash
pnpm kody run --task "Add a helper function" --cwd /path/to/test-project --local
```

## Publishing

```bash
# Bump version in package.json
pnpm build
npm publish --access public
# Update workflow in target repos: cp templates/kody.yml <target>/.github/workflows/
```

## Pipeline Stages

```
taskify (haiku)     → task.json: type, scope, risk, questions
plan (opus)         → plan.md: TDD steps
build (sonnet)      → code changes via Claude Code tools
verify (local)      → typecheck + tests + lint
review (opus)       → review.md: PASS/FAIL + findings
review-fix (sonnet) → fix Critical/Major issues
ship (local)        → git push + PR creation
```

## How Stages Execute

1. `pipeline.ts` calls `buildFullPrompt()` — reads memory + prompt template + task artifacts (with L0/L1/L2 tiered context)
2. `resolveModel()` maps modelTier to model name (or LiteLLM alias)
3. `agent-runner.ts` spawns `claude --print --model <model> --dangerously-skip-permissions`
4. Prompt piped via stdin, stdout collected
5. For print-mode stages (taskify, plan, review): output written to artifact file
6. For tool-use stages (build, review-fix, autofix): Claude Code modifies files directly

## Special Behaviors

- **Question gates:** After taskify/plan, checks for questions → posts on issue, pauses with `kody:waiting`
- **Complexity filtering:** Low-risk tasks skip plan/review. Auto-detected from taskify's risk_level.
- **Verify+autofix loop:** Fails → lint-fix → format-fix → autofix agent → retry (max 2)
- **Review+fix loop:** FAIL verdict → review-fix agent → re-review
- **Branch sync:** Merges default branch into feature branch before every run
- **Paused state:** `state.state = "failed"` with `error: "paused: waiting for answers"`. Entry.ts detects this and exits 0.

## Non-Anthropic Models

Claude Code works with any model through LiteLLM proxy:

```
Claude Code CLI → LiteLLM proxy → MiniMax/OpenAI/Gemini/etc.
```

Set the `provider` field — Kody auto-generates LiteLLM config, starts the proxy, and sets `ANTHROPIC_BASE_URL`. LiteLLM translates tool-use protocol. Tested with MiniMax (Write, Read, Edit, Bash, Grep all work).

Config:
```json
{
  "agent": {
    "provider": "minimax"
  }
}
```

For per-tier model control, configure `modelMap` in `kody.config.json`.
