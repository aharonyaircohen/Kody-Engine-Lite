# FAQ

## General

**Q: What languages/frameworks does Kody support?**
Any. Kody uses Claude Code which supports all programming languages. The quality gates run whatever commands you configure in `kody.config.json`.

**Q: How much does it cost per task?**
**Kody can be completely free.** Route through LiteLLM to free-tier models (Google Gemini, etc.) and pay nothing. With paid models: LOW tasks ~$0.30-1.00, MEDIUM ~$1-3, HIGH ~$3-8. No subscriptions, no per-seat pricing — ever.

**Q: Can I use it without GitHub?**
The CLI works locally (`--local` flag) without GitHub. The full CI/CD pipeline requires GitHub Actions.

**Q: Does it work with monorepos?**
Yes. Use `--cwd` to point to the specific package directory. Each package can have its own `kody.config.json`.

**Q: What does `init` do exactly?**
Spawns Claude Code to analyze your project, then generates: workflow file, config with auto-detected quality commands, project memory (architecture + conventions), **6 repo-customized step files** (`.kody/steps/` — tailored prompts for each pipeline stage), and 14 GitHub labels — then commits and pushes. See [Configuration](CONFIGURATION.md).

**Q: What are step files (`.kody/steps/`)?**
Customized instruction files for each pipeline stage, generated during `init`. They contain the engine's default prompt plus three sections specific to your repo: **Repo Patterns** (real code examples to follow), **Improvement Areas** (gaps to fix incrementally), and **Acceptance Criteria** (concrete quality checklist). This means Kody writes code that matches your existing patterns and improves known gaps. See [Features](FEATURES.md#repo-aware-step-files-kodysteps).

**Q: Can I edit the step files?**
Yes. They're plain markdown in `.kody/steps/`. Edit `build.md` to change how Kody writes code, edit `review.md` to change what it checks during review. Changes take effect on the next pipeline run. No engine update needed.

**Q: How do I regenerate step files after a major refactor?**
Run `kody-engine-lite init --force`. This re-analyzes your codebase and produces fresh step files reflecting the current state. Your previous customizations will be overwritten — commit them first if you want to compare.

**Q: Why is this better than CLAUDE.md or AGENTS.md?**
CLAUDE.md and AGENTS.md are generic project-wide instructions. Step files are **per-stage** — the build agent gets coding patterns and acceptance criteria, the review agent gets a review checklist, the plan agent gets architecture guidance. Each stage sees only what's relevant to it, with concrete examples instead of abstract rules.

**Q: Can Kody handle complex features (auth systems, CRUD, multi-file)?**
Yes. The pipeline is designed for complex tasks. A full auth system (JWT, sessions, middleware, RBAC, UI pages, tests) completed with all 7 stages and 3 autofix retries. Shared sessions within stage groups mean no cold-start re-exploration, and context.md carries decisions across session boundaries.

**Q: How does context flow between stages?**
Two mechanisms: (1) **Shared sessions** — stages in the same group (e.g., taskify+plan, build+autofix) share a Claude Code session, so the agent remembers everything. (2) **context.md** — each stage appends a summary. Stages in different groups (e.g., review reading build's context) get this file injected into their prompt. See [Shared Sessions](FEATURES.md#shared-sessions).

## Pipeline

**Q: What if the pipeline fails?**
Kody posts a failure comment on the issue with the failing stage and error. Rerun with `@kody rerun` or `@kody rerun --from <stage>`.

**Q: Can I skip specific stages?**
Use `--from <stage>` to start from a specific stage. Use `--complexity low` to skip plan/review. Or rerun from a specific stage after failure.

**Q: What if Kody asks questions I don't want to answer?**
Comment `@kody approve` without answers — it will proceed with its best judgment.

**Q: How does the risk gate work?**
For HIGH-risk tasks, Kody pauses after the plan stage and posts the plan on the issue. Review it, then comment `@kody approve` to continue. Reruns skip the gate. See [Features](FEATURES.md#risk-gate).

**Q: Can I run multiple issues in parallel?**
Yes. Each issue gets its own GitHub Actions run. The concurrency config is per-task, so different issues run simultaneously.

**Q: Where are artifacts stored?**
In `.tasks/<task-id>/` — includes task.json, plan.md, context.md, verify.md, review.md, ship.md, status.json. These are uploaded as GitHub Actions artifacts (7-day retention).

**Q: What triggers a rerun vs a new run?**
`@kody` always starts a new run with a fresh task ID. `@kody rerun` resumes the last task for that issue from the failed/paused stage.

## Models

**Q: Which models work with Kody?**
Any model that supports tool use. Anthropic models (haiku/sonnet/opus) are the default. MiniMax M2.7-highspeed is validated for all stages via LiteLLM. See [LiteLLM guide](LITELLM.md).

**Q: How do I switch to a different model (e.g., MiniMax)?**
Add a `litellm-config.yaml` mapping Anthropic model IDs to your provider, and set `litellmUrl` in kody.config.json. Kody auto-starts the proxy. See [LiteLLM guide](LITELLM.md#setup).

**Q: Can I use different models for different stages?**
Yes. The `modelMap` in config maps tiers (cheap/mid/strong) to model names. Or use `stageRunners` for per-stage runner assignment.

**Q: Can I use local models (Ollama)?**
Yes, via LiteLLM proxy. Configure Ollama as a provider in `litellm-config.yaml`. Performance depends on model capability — tool use support is required.

**Q: Why can't I use custom model names like "minimax-test"?**
Claude Code validates `--model` names client-side and only accepts Anthropic model names. Use Anthropic model IDs in your LiteLLM config and let LiteLLM route to your actual backend. See [LiteLLM guide](LITELLM.md#common-gotchas).

## Security

**Q: Who can trigger Kody?**
Only GitHub collaborators (COLLABORATOR, MEMBER, OWNER). External contributors cannot trigger `@kody`.

**Q: Does Kody have access to my secrets?**
Kody runs in GitHub Actions with the secrets you configure. It has the same access as your CI/CD workflows. It does NOT send code to any service beyond the LLM API.

**Q: Can someone bypass the risk gate?**
Only authorized collaborators can comment `@kody approve`. The gate only fires in CI mode with an issue number, not locally.

**Q: Is the pipeline state safe from corruption?**
State writes are atomic (write-to-tmp + rename). A PID-based lock file prevents concurrent runs on the same task. Session IDs are persisted so reruns resume the correct conversation.
