# FAQ

## General

**Q: What languages/frameworks does Kody support?**
Any. Kody uses Claude Code which supports all programming languages. The quality gates run whatever commands you configure in `kody.config.json`.

**Q: How much does it cost per task?**
Depends on complexity. LOW tasks (utilities, configs): ~$0.30-1.00. MEDIUM tasks (multi-file features): ~$1-3. HIGH tasks (full features with review): ~$3-8. Using MiniMax or other models via LiteLLM can reduce costs.

**Q: Can I use it without GitHub?**
The CLI works locally (`--local` flag) without GitHub. The full CI/CD pipeline requires GitHub Actions.

**Q: Does it work with monorepos?**
Yes. Use `--cwd` to point to the specific package directory. Each package can have its own `kody.config.json`.

**Q: What does `init` do exactly?**
Spawns Claude Code to analyze your project, then generates: workflow file, config with auto-detected quality commands, project memory (architecture + conventions), and 14 GitHub labels. See [Configuration](CONFIGURATION.md).

**Q: Can Kody handle complex features (auth systems, CRUD, multi-file)?**
Yes. The pipeline is designed for complex tasks. A full auth system (JWT, sessions, middleware, RBAC, UI pages, tests) completed in 27 minutes with 7 stages and 3 autofix retries. Each stage gets a fresh context window with accumulated context from previous stages, so it doesn't lose track of earlier decisions like single-agent tools do.

**Q: How does context flow between stages?**
Each stage appends a summary to `.tasks/<id>/context.md` after completion. The next stage reads this file as "Previous Stage Context." This gives later stages awareness of what earlier stages explored, decided, and struggled with — without sharing a single bloated context window. Context is capped at 4000 characters from the end.

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
In `.tasks/<task-id>/` — includes task.json, plan.md, verify.md, review.md, ship.md, status.json. These are uploaded as GitHub Actions artifacts (7-day retention).

**Q: What triggers a rerun vs a new run?**
`@kody` always starts a new run with a fresh task ID. `@kody rerun` resumes the last task for that issue from the failed/paused stage.

## Models

**Q: Which model is best for Kody?**
Anthropic models (haiku/sonnet/opus) are the default and best-tested. MiniMax M2.7-highspeed works for all stages via LiteLLM.

**Q: Can I use different models for different stages?**
Yes. The `modelMap` maps tiers (cheap/mid/strong) to model names. You can also use `stageRunners` for per-stage runner assignment.

**Q: Can I use local models (Ollama)?**
Yes, via LiteLLM proxy. Configure Ollama as a provider in `litellm-config.yaml`. Performance depends on model capability — tool use support is required.

**Q: Why can't I use custom model names like "minimax-test"?**
Claude Code validates `--model` names client-side and only accepts Anthropic model names. Use Anthropic model IDs in your LiteLLM config and let LiteLLM route to your actual backend. See [LiteLLM guide](LITELLM.md).

## Security

**Q: Who can trigger Kody?**
Only GitHub collaborators (COLLABORATOR, MEMBER, OWNER). External contributors cannot trigger `@kody`.

**Q: Does Kody have access to my secrets?**
Kody runs in GitHub Actions with the secrets you configure. It has the same access as your CI/CD workflows. It does NOT send code to any service beyond the LLM API.

**Q: Can someone bypass the risk gate?**
Only authorized collaborators can comment `@kody approve`. The gate only fires in CI mode with an issue number, not locally.

**Q: Is the pipeline state safe from corruption?**
State writes are atomic (write-to-tmp + rename). A PID-based lock file prevents concurrent runs on the same task.
