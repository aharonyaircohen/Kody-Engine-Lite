# Kody-Engine-Lite — Developer Onboarding

## What is this?

An autonomous SDLC pipeline as an npm package. Users comment `@kody` on a GitHub issue → 7-stage pipeline runs → PR created. No human intervention needed.

## Architecture

```
@kody on GitHub issue
  → GitHub Actions workflow
    → kody-engine-lite CLI
      → state-machine.ts (7 stages)
        → Claude Code (agent with tool use)
          → PR created
```

**Design principles:**
- Orchestrator is dumb — runs stages in order, no reasoning
- Agent runner is a thin subprocess wrapper — spawn, pipe, timeout, return
- All intelligence lives in Claude Code + prompt templates
- Any model works via LiteLLM proxy (tested: MiniMax with full tool use)

## Key Files

| File | What it does |
|------|-------------|
| `src/state-machine.ts` | The heart — pipeline loop, stage dispatch, question gates, complexity, auto-learn |
| `src/entry.ts` | CLI — run/rerun/fix/status, task-id resolution, issue fetching |
| `src/agent-runner.ts` | Spawns `claude --print`, pipes prompt, collects output |
| `src/context.ts` | Builds prompts — reads memory, injects task context |
| `src/bin/cli.ts` | Package entry — smart init (LLM-powered), version |
| `templates/kody.yml` | GitHub Actions workflow installed in target repos |
| `prompts/*.md` | Stage instructions for Claude Code |

## Dev Commands

```bash
pnpm install          # Install
pnpm typecheck        # Type check
pnpm test             # 125 tests
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

1. `state-machine.ts` calls `buildFullPrompt()` — reads memory + prompt template + task artifacts
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

Set `ANTHROPIC_BASE_URL` to the proxy URL. LiteLLM translates tool-use protocol. Tested with MiniMax (Write, Read, Edit, Bash, Grep all work).

Config:
```json
{
  "agent": {
    "litellmUrl": "http://localhost:4000",
    "modelMap": { "cheap": "minimax", "mid": "minimax", "strong": "minimax" }
  }
}
```
