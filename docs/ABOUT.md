# Why Kody?

> For deep dives with code examples, see [Features](FEATURES.md). For setup, see [Configuration](CONFIGURATION.md).

**Issue → tested PR. Free and open source.**

Claude Code is a powerful AI coding agent. But it's a single agent — you prompt, it codes, you verify. Kody wraps it with a 7-stage autonomous pipeline that classifies, plans, builds, verifies, reviews, fixes, and ships — with quality gates between every stage.

Comment `@kody` on an issue, walk away, come back to a tested PR. Comment `@kody review` on any PR for an instant structured code review. Run locally or via GitHub Actions. Use Anthropic models or free ones via LiteLLM.

---

## Bootstrap — How Kody Learns Your Repo

`kody init` analyzes your codebase and generates customized instruction files for every pipeline stage in `.kody/steps/`. Each contains repo patterns (real code examples), improvement areas (gaps to fix), and acceptance criteria (concrete quality checklist). The AI writes code that matches your project because it was taught from your project.

```
Generic prompt:                          Repo-aware step file:

"Write clean code"                       "Follow the collection pattern in
                                          src/collections/certificates.ts:
                                          always cast relationTo with as
                                          CollectionSlug, register in
                                          payload.config.ts"

"Add error handling"                     "Use sanitizeHtml/sanitizeSql from
                                          src/security/sanitizers.ts for all
                                          user-supplied strings before
                                          persistence"

"Write tests"                            "Co-locate as *.test.ts, use Vitest,
                                          run pnpm test:int, test access
                                          control denial for every new
                                          collection"
```

Bootstrap also generates project memory (`.kody/memory/` — architecture and conventions injected into every prompt) and sets up the GitHub Actions workflow. Two minutes from `npm install` to first `@kody`. Fully editable markdown — change how Kody works by editing a file. [Full step files reference →](FEATURES.md#repo-aware-step-files-kodysteps)

---

## Pipeline — What Happens When You Trigger @kody

Seven stages, each with a clear objective, output artifacts, and quality gates between them. Not a single agent conversation that drifts — if stage 4 catches a bug, the pipeline fixes it before stage 5 ever sees it.

| Stage | What It Does | Output |
|-------|-------------|--------|
| **Taskify** | Classify task, detect complexity, ask questions | `task.json` |
| **Plan** | TDD implementation plan with deep reasoning | `plan.md` |
| **Build** | Implement code via Claude Code tools | code + commit |
| **Verify** | typecheck + tests + lint with AI diagnosis | `verify.md` |
| **Review** | Code review: PASS/FAIL + Critical/Major/Minor | `review.md` |
| **review-fix** | Fix Critical and Major review findings | code + commit |
| **Ship** | Push branch, create PR, close issue | PR |

Low-complexity tasks skip plan/review. HIGH-risk tasks pause for human approval after plan. Stages share Claude Code sessions within groups so agents never start cold. [Full pipeline details →](PIPELINE.md)

Key pipeline capabilities:
- **Shared sessions** — no cold-start re-exploration between grouped stages ([details](FEATURES.md#shared-sessions))
- **Risk gate** — HIGH-risk tasks pause for human approval before code is written ([details](FEATURES.md#risk-gate))
- **Question gates** — asks product/architecture questions when the task is unclear ([details](FEATURES.md#question-gates))
- **AI failure diagnosis** — 5-way classification (fixable/infrastructure/pre-existing/retry/abort) before deciding to fix, skip, or stop ([details](FEATURES.md#ai-powered-failure-diagnosis))
- **Standalone PR review** — `@kody review` on any PR for structured review with GitHub approve/request-changes ([details](FEATURES.md#standalone-pr-review))
- **Rerun from any stage** — keep what worked, don't redo the 20-minute build when only the last step failed

---

## Intelligence — Systems That Get Better Over Time

Kody doesn't just execute — it learns. Each run makes the next one better:

- **Auto-learning** — extracts conventions (testing patterns, lint rules, import conventions) from each successful run and saves them to `.kody/memory/conventions.md` ([details](FEATURES.md#auto-learning-memory))
- **Pattern discovery** — searches the codebase for existing solutions before proposing new ones ([details](FEATURES.md#pattern-discovery))
- **Decision memory** — architectural decisions from code reviews persist across tasks in `.kody/memory/decisions.md` ([details](FEATURES.md#decision-memory))
- **Retrospective** — analyzes each run for patterns, suggestions, and pipeline-level flaws ([details](FEATURES.md#retrospective-system))
- **Incremental improvement** — step files encode known gaps; every task that touches related code fixes them

---

## Flexibility — How You Run It

### CLI + GitHub Actions

Run locally from your terminal for testing and development:
```bash
kody-engine-lite run --issue-number 42 --local --cwd ./project
```

Run remotely via GitHub Actions for production — comment `@kody` on any issue. Same engine, same pipeline, same quality gates.

### Any LLM via LiteLLM

Use Anthropic models natively, or route through free-tier models (Google Gemini, etc.) via LiteLLM at zero cost. Set `provider` in config, add your API key, done. Kody auto-starts the LiteLLM proxy and loads API keys from `.env`.

### Auto Fix-CI

CI fails on a Kody PR? Kody automatically fetches the failure logs, diagnoses the issue, and pushes a fix. Loop guards prevent infinite cycles — max 1 attempt per 24h, skips if last commit was from bot. Also triggerable manually: `@kody fix-ci`.

### Configurable Model Tiers

Each stage runs at a configurable tier (cheap/mid/strong). Route taskify through a fast cheap model, plan through a deep reasoning model, build through a balanced one. Or run everything through one free model — your call.

### PR Feedback Loop

`@kody fix` automatically collects three layers of context: Kody's own review findings, human PR review comments (inline and top-level), and any additional feedback in the comment body. Human feedback is scoped to the current fix cycle — only comments posted after the last Kody action are included.

See the [full command reference](CLI.md) for all commands, flags, and options.

---

## How Kody Compares

Most AI coding tools are single-agent conversations — one long context that drifts, no quality gates, start over on failure. Kody is a structured pipeline with checkpoints at every stage.

Key differentiators vs Copilot Workspace, Devin, Cursor, Cline, and OpenHands:
- **Structured stages** — 7 stages with quality gates, not a single agent loop
- **Repo-aware prompts** — auto-generated per repo, not generic instructions
- **Fire and forget** — runs in GitHub Actions, no IDE required
- **AI failure diagnosis** — 5-way classification before retry, not blind loops
- **Rerun from any stage** — keep what worked, don't start over
- **Free option** — use free-tier models via LiteLLM for zero cost

[Full side-by-side comparison →](COMPARISON.md)

---

## Real-World Example

**Task:** Build a full authentication system (#29)

**What Kody built autonomously:** JWT service, session store, user store with lockout, auth middleware, role guard, 5 API routes, 3 UI pages, auth context, shared components, and tests.

**How the pipeline handled it:**
- **Taskify** detected HIGH complexity → all 7 stages activated
- **Plan** produced a TDD implementation plan with deep reasoning
- **Build** implemented the full auth system via Claude Code
- **Verify** failed twice (lint errors in React code) → AI diagnosed as "fixable" → autofix agent fixed both → passed on attempt 3
- **Review** PASS with minor findings → review-fix applied them
- **Ship** created a PR with working code and passing tests

**Model used:** MiniMax via LiteLLM (not Anthropic — demonstrating model flexibility)

**Result:** Issue → tested, reviewed PR. Fully autonomous. Zero human intervention.

---

## Get Started

```bash
npm install -g @kody-ade/kody-engine-lite
cd your-project
kody-engine-lite init
```

Then comment `@kody` on any GitHub issue.

[Pipeline details →](PIPELINE.md) · [Configuration →](CONFIGURATION.md) · [LiteLLM setup →](LITELLM.md) · [Full comparison →](COMPARISON.md)
