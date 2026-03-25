# Phase 8 — Feature Parity with Kody-Engine

## Goal
Close the remaining feature gaps between Kody-Engine-Lite (after Phase 1-7) and the original Kody-Engine at `/Users/aguy/projects/Kody-Engine/`. This phase starts with a **live gap analysis** — the implementer must discover gaps themselves by reading both codebases — then plan and close them.

## Prerequisite
Phase 7 complete — Brain/Engine split deployed.

## Reference codebase
`/Users/aguy/projects/Kody-Engine/` — the original implementation using OpenCode CLI + MiniMax.

---

## Step 0: Run live gap analysis (MANDATORY before any implementation)

**Do NOT rely on the known gaps listed below.** They were identified during planning and may be outdated by the time Phase 8 starts. The implementer MUST run their own analysis.

### Instructions for the implementer

1. **Read every file in both codebases.** Do not skip files.

   ```
   Kody-Engine (reference):
     /Users/aguy/projects/Kody-Engine/src/engine/*.ts          — all source files
     /Users/aguy/projects/Kody-Engine/src/engine/prompts/*.md   — all prompts
     /Users/aguy/projects/Kody-Engine/.github/workflows/*.yml   — CI/CD
     /Users/aguy/projects/Kody-Engine/opencode.json             — agent config
     /Users/aguy/projects/Kody-Engine/kody.config.json          — project config
     /Users/aguy/projects/Kody-Engine/package.json              — dependencies

   Kody-Engine-Lite (current):
     /Users/aguy/projects/Kody-Engine-Lite/src/*.ts             — all source files
     /Users/aguy/projects/Kody-Engine-Lite/prompts/*.md         — all prompts
     /Users/aguy/projects/Kody-Engine-Lite/.github/workflows/   — CI/CD
     /Users/aguy/projects/Kody-Engine-Lite/kody.config.json     — project config
     /Users/aguy/projects/Kody-Engine-Lite/package.json         — dependencies
   ```

2. **For each function/feature in Kody-Engine**, check if Kody-Engine-Lite has an equivalent. Use this checklist:

   - [ ] Every exported function in `src/engine/*.ts` has an equivalent in Lite
   - [ ] Every prompt in `prompts/` has equivalent content and output contracts
   - [ ] Every workflow trigger, job, and step has an equivalent
   - [ ] Every env var used in the workflow is accounted for
   - [ ] Every CLI flag and command has an equivalent
   - [ ] Every config option has an equivalent
   - [ ] Every error handling pattern has an equivalent

3. **Categorize each finding:**
   - **PORTED** — exists in Lite with equivalent functionality
   - **INTENTIONALLY DIFFERENT** — replaced by a different approach (document why)
   - **MISSING** — needs to be implemented
   - **DEFERRED** — known gap, intentionally left (document reason)

4. **Write findings to a file:** Create `PHASE-8-GAP-ANALYSIS.md` in the project root with:
   - Date of analysis
   - Per-file comparison (Kody-Engine file → Lite equivalent)
   - List of MISSING items with severity (P0/P1/P2)
   - List of INTENTIONALLY DIFFERENT items with justification
   - Recommended implementation order

5. **Only after the analysis is complete**, implement the MISSING items in priority order.

### What to look for specifically

- **Functions that exist in Kody-Engine but have no equivalent in Lite** — these are the real gaps
- **Edge cases handled in Kody-Engine but not in Lite** — error paths, fallbacks, timeouts
- **Workflow steps/jobs that don't exist in Lite's workflow** — CI features
- **Environment variables injected in CI that Lite doesn't use** — may indicate missing features
- **Config options that Lite doesn't support** — flexibility gaps
- **Prompt content differences** — output contracts, instructions, heuristics

### What is NOT a gap

- OpenCode CLI invocation syntax (replaced by Claude Code)
- MiniMax/direct provider coupling (replaced by LiteLLM)
- `.opencode/` directory and agent definitions (replaced by prompt templates)
- `znv` dependency (replaced by zod)
- Any feature that was explicitly removed in the design phase (check PLAN-FULL.md)

---

## Known gaps after Phase 1-7 (reference — verify these are still accurate)

### 1. Mock LLM Server (record/replay testing)

**Kody-Engine:** `.github/workflows/kody.yml` lines 409-459 — starts a mock LLM server in replay/record mode for CI testing without real API calls. Uses recorded responses stored on dev branch.

**Lite status:** Not in any phase.

**Why it matters:** Without this, every CI run costs real API tokens. Testing pipeline changes is expensive.

**Implementation:**
- Record mode: proxy LLM calls, save request/response pairs to `.recordings/`
- Replay mode: serve recorded responses, fail if no match
- Workflow flag: `use_mock: boolean` input
- ~150 lines (mock server) + ~30 lines (workflow changes)

### 2. Pipeline Version Overlay

**Kody-Engine:** `.github/workflows/kody.yml` lines 488-504 — `--version` flag overlays pipeline code from a specific branch/tag/commit. Allows running old pipeline against new features.

**Lite status:** `version` input exists in Phase 6 workflow dispatch but implementation not specified.

**Implementation:**
- Checkout pipeline code from specified ref into temp directory
- Overlay `src/` and `prompts/` from that ref
- Run with overlaid code
- ~40 lines in workflow

### 3. Complexity Score / Task Profiling

**Kody-Engine:** `complexity` input in workflow + `profile` field in TaskJson (`standard`/`lightweight`/`turbo`).

**Lite status:** `complexity` input exists in Phase 6 workflow but not wired. `profile` field in TaskJson type but not used.

**Implementation:**
- Route tasks to different model tiers based on complexity score
- `lightweight` profile → all stages use `cheap` model
- `turbo` profile → all stages use `strong` model
- ~30 lines in config + context resolution

### 4. NPM Package Distribution

**Kody-Engine:** `packages/kody-engine/` — distributable npm package with `@kody-ade/kody-engine` name, separate `src/bin/cli.ts` entry point.

**Lite status:** Not in any phase. Currently runs via `tsx src/entry.ts`.

**Implementation:**
- Add `packages/kody-engine-lite/` with package.json
- Build step: `tsc` → `dist/`
- CLI binary entry: `#!/usr/bin/env node`
- Publish to npm
- ~100 lines (package config + CLI wrapper)

### 5. Extended Agent Definitions (beyond 7 pipeline stages)

**Kody-Engine opencode.json:** 21 agents including specialized roles not in the 7-stage pipeline:
- `architect` — architecture design
- `clarify` — collect operator questions
- `gap` / `plan-gap` — analyze spec/plan for gaps
- `test` / `test-writer` / `e2e-test-writer` — test generation
- `advisor` — code review suggestions
- `kody-expert` — pipeline debugging expert
- `build-manager` — orchestrate build + test agents
- `browser` — browser automation
- `reflect` — post-task learning
- `fix` — targeted fixes

**Lite status:** Only 7 pipeline stages + autofix. LiteLLM config has aliases for `clarify`, `test-writer`, `reflect` but no stage definitions.

**Implementation:** Define additional stages as optional extensions. Not all need to be in the pipeline — some can be standalone commands:
```
kody clarify --task-id <id>     # Ask clarifying questions
kody test --task-id <id>        # Generate tests only
kody reflect --task-id <id>     # Post-task learning
```
~200 lines (new stage definitions + entry point commands)

### 6. Spec Stage / Gap Analysis Stage

**Kody-Engine:** Has `spec` mode that only runs taskify → spec stages. Also has `gap` and `plan-gap` agents for analyzing specs and plans for missing information.

**Lite status:** Only `full` and `rerun` modes. No spec-only mode.

**Implementation:**
- Add `spec` mode to entry.ts: run only taskify + plan
- Add `impl` mode: run from build onward (assumes task.json + plan.md exist)
- ~30 lines in entry.ts + state machine

### 7. Feedback Loop / Build Feedback

**Kody-Engine:** `--feedback` flag passes human feedback text to agents. `MAX_BUILD_FEEDBACK_LOOPS: 2` constant suggests iterative build with human input.

**Lite status:** `--feedback` flag defined in entry.ts but not passed to agent prompts.

**Implementation:**
- Inject feedback into task context as `## Human Feedback` section
- Add to `injectTaskContext()` in context.ts
- ~15 lines

### 8. Post-Failure Comments in Entry Point

**Kody-Engine:** `entry.ts` lines 151-157 — posts GitHub comment on pipeline failure (not just from state machine).

**Lite status:** Phase 6 has `notify-orchestrate-error` job in workflow, but entry.ts doesn't post failure comments directly.

**Implementation:**
- In entry.ts: if pipeline fails and issueNumber is set, post comment with failure summary
- ~15 lines in entry.ts

### 9. Self-Hosted Runner Optimization

**Kody-Engine:** Workflow supports self-hosted runners with custom pnpm store dir (`/Users/bot/Library/pnpm/store/v10`), workspace cleanup (`rm -rf .next dist coverage`).

**Lite status:** `runner` input exists in Phase 6 workflow but self-hosted-specific steps not implemented.

**Implementation:**
- Conditional pnpm store path for self-hosted
- Workspace cleanup step (self-hosted only)
- ~30 lines in workflow

### 10. OpenCode-Specific Features (may not apply)

**Kody-Engine features that may NOT port to Claude Code:**
- `.opencode/agents/` directory with agent-specific instructions
- `.opencode/docs/PIPELINE.md` and `BROWSER_AUTOMATION.md` instruction files
- `opencode github run --agent <name>` syntax with named agents

**Lite equivalent:** Claude Code uses `--system-prompt` for per-stage instructions (already handled by prompt templates in prompts/). No separate agent definition system needed.

**Status:** INTENTIONALLY DIFFERENT — not a gap.

### 11. Database / Blob Storage Integration

**Kody-Engine:** Workflow injects `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`.

**Lite status:** Not in any phase. Purpose unclear — may be for unit tests that need a database, or for artifact storage.

**Investigation needed:** Check if these are for the target project's tests or for Kody's own state. If for target project tests, they should be in kody.config.json as passthrough env vars.

### 12. Canary Tests

**Kody-Engine:** Smoke test job runs `test:canary` separately from `test:unit`.

**Lite status:** Phase 6 smoke test runs typecheck + CLI validation + dry-run. No canary tests.

**Implementation:**
- Add `test:canary` script that runs a real (but small) pipeline task
- Verifies end-to-end: CLI → agent → output
- ~20 lines in workflow + test task

---

## Summary table

| # | Feature | Kody-Engine Location | Lite Phase | Status | Effort |
|---|---------|---------------------|-----------|--------|--------|
| 1 | Mock LLM server | workflow 409-459 | — | MISSING | ~180 lines |
| 2 | Pipeline version overlay | workflow 488-504 | P6 (partial) | INCOMPLETE | ~40 lines |
| 3 | Complexity/profiling | workflow + TaskJson | P3 (type only) | INCOMPLETE | ~30 lines |
| 4 | NPM package distribution | packages/ | — | MISSING | ~100 lines |
| 5 | Extended agents (14 extra) | opencode.json | P5 (aliases only) | MISSING | ~200 lines |
| 6 | Spec/impl modes | entry.ts | — | MISSING | ~30 lines |
| 7 | Feedback injection | entry.ts + context | P3 (flag only) | INCOMPLETE | ~15 lines |
| 8 | Post-failure comments | entry.ts 151-157 | P6 (workflow only) | INCOMPLETE | ~15 lines |
| 9 | Self-hosted runner | workflow | P6 (input only) | INCOMPLETE | ~30 lines |
| 10 | OpenCode agent system | .opencode/ | — | INTENTIONAL | N/A |
| 11 | DB/blob env vars | workflow | — | NEEDS INVESTIGATION | ~10 lines |
| 12 | Canary tests | workflow smoke | P6 (basic) | INCOMPLETE | ~20 lines |

**Total new work:** ~670 lines
**Total incomplete items to finish:** ~130 lines

## Priority order

### P0 — Must have for production parity
1. Mock LLM server (#1) — cost control for CI
2. Feedback injection (#7) — human-in-the-loop
3. Post-failure comments (#8) — visibility

### P1 — Important for usability
4. Spec/impl modes (#6) — workflow flexibility
5. Pipeline version overlay (#2) — safe deployments
6. Complexity routing (#3) — cost optimization

### P2 — Nice to have
7. Self-hosted runner (#9) — performance
8. Canary tests (#12) — reliability
9. NPM distribution (#4) — distribution
10. Extended agents (#5) — expanded capabilities

### Deferred
11. DB/blob integration (#11) — needs investigation
12. OpenCode agent system (#10) — intentionally different

## Verification
```bash
# After Phase 8 implementation, run full gap analysis:
# 1. List all functions in Kody-Engine
grep -r "export function\|export async function" /Users/aguy/projects/Kody-Engine/src/engine/ | wc -l

# 2. List all functions in Kody-Engine-Lite
grep -r "export function\|export async function" src/ | wc -l

# 3. Compare workflow features
diff <(grep -oP '^\s+\w+:' /Users/aguy/projects/Kody-Engine/.github/workflows/kody.yml | sort) \
     <(grep -oP '^\s+\w+:' .github/workflows/kody.yml | sort)

# 4. Compare env vars
diff <(grep -oP '\$\{\{\s*secrets\.\w+' /Users/aguy/projects/Kody-Engine/.github/workflows/kody.yml | sort -u) \
     <(grep -oP '\$\{\{\s*secrets\.\w+' .github/workflows/kody.yml | sort -u)

# 5. Run both pipelines on same task, compare outputs
```
