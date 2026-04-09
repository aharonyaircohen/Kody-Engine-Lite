# Memory System

Kody's memory system lets the pipeline learn across runs. Every stage gets context from previous runs — what worked, what failed, what patterns the codebase uses — without re-discovering it each time.

Storage is flat files in `.kody/memory/`, persisted to the default branch via git. No database, no external service.

## Architecture

```
.kody/memory/
├── architecture.md              # facts hall — auto-detected tech stack
├── facts_architecture.md        # facts hall (new naming convention)
├── conventions.md               # conventions hall — global learnings
├── conventions_auth.md           # conventions hall — room-scoped (auth)
├── conventions_middleware.md     # conventions hall — room-scoped (middleware)
├── observer-log.jsonl           # events hall — retrospective entries
├── diary_build.jsonl            # stage diary — build patterns
├── diary_verify.jsonl           # stage diary — verify patterns
└── diary_review.jsonl           # stage diary — review patterns
```

## Halls

Memory files are categorized into **halls** — types of information that different stages need:

| Hall | Contains | Used by |
|------|----------|---------|
| `facts` | Architecture, tech stack, framework versions | All stages |
| `conventions` | Code patterns, imports, naming, tooling | build, review, autofix |
| `events` | Run observations, retrospective log | plan, retrospective |
| `preferences` | Learned preferences from reviews | build, review |

Files are assigned to halls by filename prefix (`facts_`, `conventions_`, `events_`, `preferences_`). Legacy files without prefix are auto-classified: `architecture.md` → facts, `conventions.md` → conventions, `observer-log.jsonl` → events.

Each pipeline stage has a **hall policy** that controls which halls it loads:

```
taskify  → facts only
plan     → facts, conventions, events
build    → facts, conventions, preferences
autofix  → conventions only
review   → facts, conventions, preferences
```

## Rooms

Within halls, memory can be scoped to **rooms** — topics derived from the task's file scope. A task touching `src/auth/` loads memory from the `auth` room; a task touching `src/middleware/` loads the `middleware` room.

Room scoping prevents irrelevant conventions from cluttering the prompt. Global files (no room tag, like `conventions.md`) are always included.

**How rooms are inferred:**

1. `task.json` contains a `scope` array of file paths
2. The first significant directory in each path becomes a room: `src/auth/withAuth.ts` → `auth`
3. Memory files are tagged by filename: `conventions_auth.md` belongs to the `auth` room
4. Untagged files are global — always loaded regardless of room filter

## Tiers

Memory content is loaded at three compression levels depending on the stage's needs:

| Tier | Tokens | Format | When |
|------|--------|--------|------|
| **L0** | ~30-100 | AAAK compressed shorthand | autofix, review-fix (minimal context) |
| **L1** | ~150-500 | Headings + bullets overview | taskify, build, review (working context) |
| **L2** | Full | Unmodified content | Rarely — only when policy specifies |

### L0 Compression (AAAK-style)

L0 converts structured markdown into a compact single-line format that LLMs read natively:

```
Input (L2):                              Output (L0):
# Architecture                           ARCHITECTURE|framework:Next.js 16|
## Overview                               language:TypeScript 5.7|testing:vitest|
- Framework: Next.js 16                   cms:Payload CMS|package_manager:pnpm
- Language: TypeScript 5.7
- Testing: vitest
- CMS: Payload CMS
- Package manager: pnpm
```

### Token savings example

On a project with 1,900 tokens of memory:

| Stage | Tier + Filter | Tokens | Savings |
|-------|--------------|--------|---------|
| taskify | L1, facts only | 68 | 96% |
| build | L1, facts+conventions+preferences, room-scoped | 250 | 87% |
| autofix | L0 compressed, conventions only | 1,473 | 23% |
| review | L1, facts+conventions+preferences, room-scoped | 272 | 86% |

## Run History

Each pipeline run records its outcome in `.kody/runs/{issue}.jsonl`:

```json
{"runId":"544-260407-202316","issueNumber":544,"command":"run","outcome":"failed","failedStage":"verify","stagesCompleted":["taskify","plan","build"]}
```

Run history is injected into stage prompts in compressed format:

```
PREV_RUNS|3total
R1:544-2604(run)FAIL@verify|err:tests.failed.with.3.errors|done:taskify,plan,build
R2:544-2604(rerun)OK|done:all
R3:544-2604(fix)FAIL@build|err:type.error.missing.prop|done:taskify,plan
```

### Contradiction detection

Before injecting run history, the engine analyzes patterns across runs:

- **Repeated failure**: same stage failed 2+ times → `!REPEAT_FAIL@verify(2x)|approach.fundamentally.wrong`
- **Approach loop**: identical stage sequence across failed runs → `!LOOP:taskify,plan,build→FAIL(2x)|try.different.strategy`
- **Feedback ignored**: feedback given but next run fails at same stage → `!FB_IGNORED:"fix types"|still.fail@build`

These warnings are appended to the compressed history, giving the LLM explicit signals to change strategy.

## Stage Diaries

Each pipeline stage maintains a diary of patterns it encounters across runs. Over time, stages accumulate domain expertise about the codebase.

Storage: `.kody/memory/diary_{stage}.jsonl` — one JSON entry per line.

```json
{"taskId":"596-260407","timestamp":"2026-04-07T18:46:11Z","stage":"review","patterns":["verdict:PASS","finding:security"],"room":"middleware"}
```

**What each stage records:**

| Stage | Patterns extracted |
|-------|-------------------|
| build | Files created, import styles (path aliases, .js extensions, relative) |
| verify | Test results (pass/fail counts), pre-existing failures, typecheck/lint status |
| review | Verdict (PASS/FAIL), finding categories (security, type-safety, naming, coverage) |

Diary entries are injected as compressed context before each stage runs:

```
STAGE_DIARY|2entries
2026-04-07:596-260407@middleware|verdict:PASS|finding:security
2026-04-06:530-260406@utils|verdict:PASS|finding:type-safety
```

## Auto-Learning

After each successful run, `auto-learn.ts` extracts conventions from pipeline artifacts and writes them to memory.

**Sources:**
- `verify.md` → testing framework, coverage, pre-existing failure signatures
- `review.md` → import conventions, path aliases, client directives
- `context.md` → ORM usage (Zod, Prisma, Drizzle, Payload)
- `task.json` → active directories from scope

**Deduplication:** Each learning is checked against existing file content before appending. `"- Uses vitest for testing"` is written once, not on every run.

**Pruning:** When a conventions file exceeds 40 sections, it's pruned to keep the 25 most recent — preventing unbounded growth.

**Room tagging:** Review-derived learnings are written to both the global `conventions.md` and a room-specific file (`conventions_{room}.md`) based on the task's primary scope directory.

## Memory Nudges

After a successful task completion, an LLM-driven nudge engine reviews the pipeline artifacts and asks: *"Should I save any pattern from this task?"* Identified patterns are written directly to graph memory as facts, conventions, preferences, or thoughts.

**Opt-in:** `KODY_MEMORY_NUDGE=true` env var (disabled by default).

**What it analyzes:**
- `task.md` / `task.json` — task type, scope, risk
- `plan.md` — what was planned and why
- `review.md` — coding conventions found
- `verify.md` — tooling patterns (test framework, coverage, pre-existing failures)
- `ship.md` — what was shipped

**Output:** Patterns written to graph memory via `writeFact()` with a `nudge` episode. Example log output:

```
Nudge: saved 3 pattern(s) from 840-260409-110822
  [facts] memory-nudge-feature: The memory nudge feature in src/memory/nudge.ts analyzes task artifacts...
  [conventions] task-artifacts: Tasks generate structured artifacts (task.md, task.json, verify.md...) that...
  [thoughts] verify-stage-errors: TypeScript type errors in .next/dev/types/ may occur from modal/Error page imports
```

**5 halls used by nudge:**

| Hall | Content |
|------|---------|
| `facts` | Factual knowledge about the project |
| `conventions` | Coding patterns and styles |
| `preferences` | User preferences from feedback |
| `thoughts` | Notable insights about this task |
| `events` | Things that happened during the run |

## Session FTS Search

Every pipeline run creates a **graph episode** — a record of what happened — stored in `.kody/graph/episodes/`. Episodes are automatically indexed into a full-text search layer for cross-run recall.

**Storage:**
- Episodes: `.kody/graph/episodes/{id}.json`
- Search index: `.kody/graph/sessions-index.json`

**Index:** Zero-dependency inverted index with BM25 ranking. Episodes are indexed on creation (no external service required).

**Sources that create episodes:**
- `nudge` — LLM-driven pattern extraction (when `KODY_MEMORY_NUDGE=true`)
- `plan` — retrospective summary of every completed pipeline run
- `ci_failure` — retrospective summary of failed runs
- `review`, `decompose`, `migration` — other pipeline events

**Search the CLI:**
```bash
kody graph search . JWT
kody graph search . "PostgreSQL Drizzle"
```

**Output includes:**
- BM25 relevance score
- Source type (nudge/plan/review/etc.)
- Highlighted snippet with matching terms marked in bold
- Episode creation date

**Example output:**
```
3 sessions matching "JWT":

[nudge] 840-260409-110822 (score: 1.3)
  Created: 2026-04-09
  LLM **nudge** identified 3 pattern(s)

[plan] 840-260409-110822 (score: 0.18)
  Created: 2026-04-09
  Task: 840-260409-110822 | Outcome: completed | Observation: completed a chore to verify the memory **nudge** feature...
```

## Persistence in CI

Run history is persisted to the default branch between CI runs:

1. After pipeline completes (even on failure), `.kody/runs/` is backed up
2. Engine switches to the default branch
3. New records are merged with existing history (append-only, deduplicated)
4. Committed and pushed with `[skip ci]` tag

This ensures run history survives across feature branches that get deleted after merge.

## Configuration

Memory behavior is controlled by `contextTiers` in `kody.config.json`:

```json
{
  "contextTiers": {
    "enabled": true,
    "tokenBudget": 8000
  }
}
```

When `contextTiers.enabled` is `false`, the legacy behavior applies — all memory files are loaded at full fidelity with no hall/room/tier filtering.

## File Reference

| File | Purpose |
|------|---------|
| `src/compress.ts` | AAAK compression, run history compression, contradiction detection |
| `src/context-tiers.ts` | Tier generation (L0/L1/L2), hall/room inference, tiered memory reader |
| `src/context.ts` | Prompt assembly, room inference from task scope, diary injection |
| `src/run-history.ts` | Run record storage, verbose and compressed formatters |
| `src/stage-diary.ts` | Diary entry types, read/write, pattern extraction per stage |
| `src/memory.ts` | Legacy flat memory reader (fallback when tiers disabled) |
| `src/learning/auto-learn.ts` | Convention extraction, dedup, prune, room-tagged writes |
| `src/retrospective.ts` | Post-run analysis, observer log, episode creation |
| `src/memory/nudge.ts` | LLM-driven pattern extraction from completed tasks |
| `src/memory/search.ts` | Inverted-index FTS with BM25 ranking over episodes |
| `src/memory/graph/episode.ts` | Episode CRUD, sequence tracking, FTS upsert on create |
| `src/memory/graph/types.ts` | Graph node/edge/episode types, EpisodeSource enum |
