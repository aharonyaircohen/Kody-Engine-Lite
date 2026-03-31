# Tech Stack

> Kody as an SDLC stack — the technologies, skills, and superpowers that turn an issue into a tested PR.

---

## Stack

| Layer | Technology | Role in the SDLC |
|-------|-----------|-------------------|
| **AI Agent** | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | The hands — reads, writes, edits, and runs commands in your repo. Sessions persist across stages so agents never start cold. |
| **LLM Routing** | [LiteLLM](https://docs.litellm.ai/) | The switchboard — route any stage through Anthropic, MiniMax, Gemini, or other providers. Swap models without touching code. |
| **Quality Gates** | Your toolchain | The guardrails — Kody runs your `typecheck`, `lint`, and `test` commands. No new tools to trust, same gates you already enforce. |
| **CI/CD** | [GitHub Actions](https://docs.github.com/en/actions) | The trigger — comment `@kody` on an issue, the pipeline runs in CI. Artifact storage, concurrency control, secret management built in. |
| **Version Control** | [Git](https://git-scm.com/) + [GitHub CLI](https://cli.github.com/) | The plumbing — branch creation, commit, push, PR creation, label lifecycle, comment posting. All via subprocess, zero SDK deps. |
| **Tool Extension** | [MCP Servers](https://modelcontextprotocol.io/) | The plugins — give Claude Code additional capabilities per stage. Browser automation, custom tools, third-party integrations. |
| **Configuration** | `kody.config.json` + `.env` | The knobs — model tiers, timeouts, quality commands, provider selection, and MCP servers. JSON schema validated. |

---

## Skills

What Kody can do across the software development lifecycle.

### Plan

- **Task classification** — analyzes the issue, detects type (feature, bugfix, refactor, docs), scope, and risk level
- **Complexity detection** — categorizes as low/medium/high; low-complexity tasks skip expensive stages automatically
- **Question gates** — when the task is ambiguous, Kody asks product/architecture questions on the issue before writing code
- **TDD planning** — produces a test-driven implementation plan with file-level changes, test cases, and execution order

### Build

- **Code implementation** — writes code using Claude Code tools (Read, Write, Edit, Bash, Glob, Grep) with full repo access
- **Session continuity** — the build agent inherits context from the plan stage, no re-exploration needed
- **Repo-aware prompts** — bootstrap-generated step files teach Kody your patterns, conventions, and known gaps

### Verify

- **Quality execution** — runs your configured typecheck, lint, and test commands
- **AI failure diagnosis** — classifies failures into 5 categories (fixable / infrastructure / pre-existing / retry / abort) before deciding what to do
- **Autofix loop** — fixable failures trigger lint fix, format fix, then an AI autofix agent, up to 2 retries

### Review

- **Structured code review** — PASS/FAIL verdict with Critical/Major/Minor findings, each with file location and fix suggestion
- **Review-fix loop** — Critical and Major findings are automatically fixed by resuming the build session (up to 2 iterations)
- **Standalone PR review** — `@kody review` on any PR for an instant structured review with GitHub approve/request-changes

### Ship

- **Branch management** — creates feature branches, syncs with base branch, handles force-with-lease push
- **PR creation** — rich PR body with What/Scope/Changes/Verify Plan sections, auto-links `Closes #N`
- **Label lifecycle** — tracks progress with labels: `kody:planning` → `kody:building` → `kody:review` → `kody:shipping` → `kody:done`

### Operate

- **Fix-CI** — automatically fetches CI failure logs, diagnoses the issue, and pushes a fix (max 1 attempt per 24h)
- **PR feedback loop** — `@kody fix` collects Kody's review findings + human PR comments + inline feedback, then applies fixes
- **Merge conflict resolution** — detects and resolves conflicts when syncing with the base branch
- **Rerun from any stage** — `@kody rerun --from build` keeps completed work, reruns from where it matters

---

## Superpowers

What makes Kody different from single-agent AI coding tools.

### Structured Pipeline, Not a Chat

Seven stages with quality gates between them. If stage 4 catches a bug, the pipeline fixes it before stage 5 ever sees it. A single-agent conversation drifts — a pipeline enforces discipline.

### Warm Sessions Across Stages

Stages are grouped into shared Claude Code sessions:
- **explore** group: taskify → plan (agent already knows the codebase when planning)
- **build** group: build → review-fix (fix agent has full implementation context)
- **review** group: fresh session (no build bias in the reviewer)

No cold starts. No re-reading the entire repo between stages.

### Repo-Aware From Day One

`kody bootstrap` analyzes your codebase and generates customized prompts per stage. Real code examples from your repo, known gaps to fix, concrete acceptance criteria. The AI writes code that matches your project because it was taught from your project.

### AI Failure Diagnosis

When verify fails, Kody doesn't blindly retry. An AI observer classifies the failure:
- **Fixable** → autofix agent with targeted resolution
- **Infrastructure** → skip (CI flake, network issue)
- **Pre-existing** → skip (bug existed before Kody touched the code)
- **Retry** → try again (transient failure)
- **Abort** → stop the pipeline (fundamental blocker)

### Self-Improving Memory

Each successful run makes the next one better:
- **Auto-learning** — extracts conventions from verify/review artifacts into `.kody/memory/conventions.md`
- **Retrospective** — post-run analysis detects recurring patterns and suggests pipeline improvements
- **Pattern discovery** — searches the codebase for existing solutions before proposing new ones

### Human-in-the-Loop When It Matters

- **Risk gate** — HIGH-risk tasks pause after planning, post the plan on the issue, and wait for human approval before writing code
- **Question gates** — unclear tasks trigger clarifying questions instead of guessing
- **Rerun with feedback** — `@kody rerun --feedback "use the existing auth middleware"` steers the next attempt

### Model Flexibility

Three tiers (cheap/mid/strong) mapped independently per stage. Run taskify on a fast cheap model, plan on a deep reasoning model, build on a balanced one. Or route everything through a free provider via LiteLLM.

---

## Flow

How the stack comes together in one pipeline run:

```
  Issue #42: "Add user authentication"
  │
  │  @kody comment triggers GitHub Actions
  ▼
┌─────────────────────────────────────────────┐
│  PLAN                                       │
│  taskify → classify, detect HIGH complexity │
│  plan → TDD implementation plan             │
│  ⚡ Shared session (warm context)            │
│  🛡️ Risk gate: HIGH → pause for approval    │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  BUILD                                      │
│  build → implement via Claude Code tools    │
│  verify → run typecheck + lint + tests      │
│  ⚡ AI diagnosis on failure → autofix loop   │
│  🔄 Up to 2 autofix retries                 │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  REVIEW                                     │
│  review → PASS/FAIL with findings           │
│  review-fix → fix Critical/Major issues     │
│  ⚡ Fresh session (no build bias)            │
│  🔄 Up to 2 review-fix iterations           │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  SHIP                                       │
│  Push branch → Create PR → Link issue       │
│  Label: kody:done                           │
│  📦 Artifacts stored for retrospective       │
└─────────────────────────────────────────────┘
```

---

[Pipeline details →](PIPELINE.md) · [Configuration →](CONFIGURATION.md) · [Architecture →](ARCHITECTURE.md) · [LiteLLM setup →](LITELLM.md)
