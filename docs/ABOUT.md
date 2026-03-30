# The Full Dev Pipeline Around Claude Code

**Issue → tested PR. Free and open source.**

Claude Code is the best AI coding engine. But it's a single agent — you prompt, it codes, you verify. Kody wraps Claude Code with a 7-stage autonomous pipeline that classifies, plans, builds, verifies, reviews, fixes, and ships — with quality gates between every stage. It also reviews your PRs on demand.

Every stage runs with instructions customized to YOUR repo's patterns. AI-powered failure diagnosis instead of blind retries. Risk-based human approval for sensitive changes. Shared sessions so agents never start cold. Memory that learns from every run.

Run it locally from your terminal or remotely via GitHub Actions. Use Anthropic models or route through free ones via LiteLLM. `kody init` bootstraps into any repo in two minutes. Comment `@kody` on an issue, walk away, come back to a PR. Comment `@kody review` on any PR for an instant code review.

```
@kody on issue
    │
    ▼
① TASKIFY ─── classify, scope, detect complexity, ask questions
    │
    ▼
② PLAN ────── TDD implementation plan (deep reasoning)
    │          🛑 HIGH risk? Pause for human approval
    ▼
③ BUILD ───── implement via Claude Code tools
    │
    ▼
④ VERIFY ──── typecheck + tests + lint
    │          ✗ fail → AI diagnosis → autofix → retry
    ▼
⑤ REVIEW ──── AI code review (fresh session, no build bias)
    │
    ▼
⑥ REVIEW-FIX ─ fix Critical and Major findings
    │
    ▼
⑦ SHIP ────── push branch, create PR, close issue
```

---

## Bootstrap — How Kody Learns Your Repo

### Repo-Aware Step Files

Every other AI coding tool sends the same generic prompt to every repo. Kody doesn't.

`kody init` analyzes your codebase — frameworks, patterns, conventions, anti-patterns, file structure — and generates customized instruction files for every pipeline stage in `.kody/steps/`. Each step file contains:

- **Repo Patterns** — real code examples from YOUR codebase showing what "good" looks like: file paths, function signatures, actual snippets
- **Improvement Areas** — gaps and anti-patterns to fix incrementally when the AI touches related code
- **Acceptance Criteria** — a concrete checklist defining "done" for each stage, grounded in your actual toolchain and quality bar

The AI writes code that looks like it belongs in your project because it was taught from your project. Fully editable markdown — change how Kody works by editing a file, no engine changes needed. Re-run `kody init --force` after major refactors to regenerate from current state.

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

### Project Memory

Bootstrap generates architecture and convention files (`.kody/memory/`) that are injected into every agent prompt. Kody knows your stack, your testing patterns, your file organization before it writes a single line.

### Two-Minute Setup

`kody init` sets up the GitHub Actions workflow, creates lifecycle labels, generates project memory and step files, and configures everything. Two minutes from `npm install` to first `@kody`.

---

## Pipeline — What Happens When You Trigger @kody

### 7 Structured Stages with Quality Gates

Not a single agent conversation that drifts. Seven stages, each with a clear objective, output artifacts, and quality gates between them. If stage 4 catches a bug, the pipeline fixes it before stage 5 ever sees it.

| Stage | What It Does | Output |
|-------|-------------|--------|
| **Taskify** | Classify task, detect complexity, ask questions | `task.json` |
| **Plan** | TDD implementation plan with deep reasoning | `plan.md` |
| **Build** | Implement code via Claude Code tools | code + commit |
| **Verify** | typecheck + tests + lint with AI diagnosis | `verify.md` |
| **Review** | Code review: PASS/FAIL + Critical/Major/Minor | `review.md` |
| **Review-Fix** | Fix Critical and Major review findings | code + commit |
| **Ship** | Push branch, create PR, close issue | PR |

### Shared Sessions

Stages in the same group share a Claude Code session. The plan agent already knows what taskify explored. The autofix agent already knows what build wrote. No cold-start re-exploration, no wasted tokens.

| Session Group | Stages | Why |
|---------------|--------|-----|
| **explore** | taskify → plan | Plan builds on taskify's codebase exploration |
| **build** | build → autofix → review-fix | Implementation context carries through |
| **review** | review (alone) | Fresh perspective, no build bias |

Cross-session context flows through `context.md` — structured summaries that every stage reads. The review agent knows what build decided even though it runs in a separate session.

### Risk Gate

HIGH-risk tasks (auth, security, data migrations, database schema) pause after the plan stage and post the full implementation plan on the issue. No code is written until a human says `@kody approve`. Medium and low tasks proceed automatically.

### Question Gates

Unclear task? Kody asks before building. Product questions during taskify ("Should search be case-sensitive?"), architecture questions during plan ("Middleware or decorator pattern?"). Pipeline pauses, posts questions on the issue, resumes when you answer.

### AI Failure Diagnosis

When verification fails, Kody doesn't blindly retry. An AI observer diagnoses the error and classifies it:

| Classification | Action | Example |
|---------------|--------|---------|
| **fixable** | autofix agent + retry | TypeScript errors in new code |
| **infrastructure** | skip — not our fault | Flaky test, network timeout |
| **pre-existing** | skip — existed before | Lint error in untouched file |
| **retry** | retry without autofix | Transient compilation error |
| **abort** | stop pipeline | Missing dependency, broken config |

The diagnosis reason and resolution are injected into the autofix agent's prompt — targeted fixes, not blind reruns.

### Verify + Autofix Loop

Failed verification triggers a structured recovery: lint fix → format fix → AI autofix agent (resuming the build session with diagnosis guidance) → retry. Up to 2 attempts with targeted fixes.

### Fresh Review Session

The review stage runs in its own session — no build bias. It reviews the code with a clean perspective, like a separate engineer who wasn't involved in writing it.

### Standalone PR Review

`@kody review` reviews any PR on demand — not just PRs that Kody created. It reads the PR diff, runs the same structured review methodology (Critical/Major/Minor findings with a PASS/FAIL verdict), posts the review as a comment, and submits an actual GitHub PR review (approve or request-changes). If the review finds issues, it tells the author to run `@kody fix` — which automatically ingests the review findings as context and fixes them. Works from CLI too: `kody-engine-lite review --pr-number 42`.

### Rerun From Any Stage

Build failed? Rerun from build. Review-fix broke something? Rerun from verify. Keep what worked, don't redo the 20-minute build when only the last step failed.

---

## Intelligence — Systems That Get Better Over Time

### Auto-Learning Memory

After each successful run, Kody extracts conventions — testing patterns, linting rules, import conventions, architecture patterns — and saves them to `.kody/memory/conventions.md`. Every future run benefits from every past success.

### Pattern Discovery

Before writing any plan, the agent searches the codebase for existing solutions. If your repo already handles localization with per-locale documents, Kody won't invent `label_en`/`label_he` fields. Every plan documents which existing patterns were found and how they're reused.

### Decision Memory

Architectural decisions are automatically extracted from code reviews and saved to `.kody/memory/decisions.md`:

- "Use existing X" / "follow existing X"
- "Instead of X, use Y" / "prefer Y over X"
- "Don't use X for Y" / "avoid X"

Decisions are deduplicated and persist across tasks. The plan agent reads them before every plan — the same mistake is never repeated.

### Retrospective

After every run (pass or fail), Kody analyzes what happened: observations, pattern matches against previous runs, actionable suggestions, and pipeline-level flaws. Stored as structured JSON in `.kody/memory/observer-log.jsonl`, building institutional knowledge over time.

### Incremental Codebase Improvement

Step files encode known gaps — missing access control, inconsistent error handling, unused patterns. Every task that touches related code fixes these issues. Quality improves organically without dedicated refactoring tickets.

---

## Flexibility

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

### Full Command Set

| Command | What it does |
|---------|-------------|
| `@kody` | Run full pipeline on an issue |
| `@kody review` | Review any PR — structured findings + GitHub review |
| `@kody fix` | Re-run with human PR review feedback |
| `@kody fix-ci` | Fix failing CI checks automatically |
| `@kody rerun` | Resume from failed or paused stage |
| `@kody approve` | Resume after risk gate or questions |
| `@kody bootstrap` | Regenerate repo intelligence |

### PR Feedback Loop

`@kody fix` automatically collects three layers of context: Kody's own review findings, human PR review comments (inline and top-level), and any additional feedback in the comment body. Human feedback is scoped to the current fix cycle — only comments posted after the last Kody action are included.

---

## Not a Copilot. Not a Chat. A Pipeline.

| | Kody | Copilot / Cursor | Devin | OpenHands |
|---|---|---|---|---|
| **Architecture** | 7-stage pipeline | Single agent | Single agent | Single agent loop |
| **PR review** | Standalone structured review + GitHub approve/request-changes | No | No | No |
| **Repo-aware prompts** | Auto-generated per repo | No | No | No |
| **Quality gates** | Between every stage | None | None | None |
| **Fire and forget** | Yes | No — IDE open | Partially | Partially |
| **Runs in** | GitHub Actions | IDE / Cloud | Devin Cloud | Docker |
| **Risk gate** | Pauses HIGH-risk for approval | No | No | No |
| **Self-improving** | Memory + decisions + retrospective | No | No | No |
| **AI failure diagnosis** | 5-way classification + targeted fix | No | No | Retry loop |
| **Shared sessions** | Across stage groups | Single conversation | Single conversation | Single conversation |
| **Rerun from stage** | Yes — keep what worked | Start over | Start over | Start over |
| **Models** | Any via LiteLLM | Vendor-locked | Proprietary | Any LLM |
| **Open source** | MIT | No | No | Apache 2.0 |
| **Cost** | Free with free models | $10-39/mo | $20-500/mo | API + infra |

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
