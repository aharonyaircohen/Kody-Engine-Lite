# FAQ

## General

**Q: What languages/frameworks does Kody support?**
Any language Claude Code supports — TypeScript, Python, Rust, Go, Java, C#, Ruby, etc. Kody doesn't enforce a specific framework. Quality gates run whatever commands you configure: `pnpm vitest` for TypeScript, `pytest` for Python, `cargo test` for Rust, and so on.

**Q: How much does it cost per task?**
**Kody can be completely free.** Route through LiteLLM to free-tier models (Google Gemini, etc.) and pay nothing. With paid models: LOW tasks ~$0.30-1.00, MEDIUM ~$1-3, HIGH ~$3-8. No subscriptions, no per-seat pricing — ever.

**Q: Can I use it without GitHub?**
The CLI works locally (`--local` flag) without GitHub. The full CI/CD pipeline requires GitHub Actions.

**Q: How do I test locally before using GitHub Actions?**
After `kody-engine-lite init`, run tasks locally with the CLI:
```bash
kody-engine-lite run --issue-number 42 --local --cwd ./project
kody-engine-lite run --task "Add retry utility" --local
```
The `--local` flag is auto-enabled outside CI. You'll need Claude Code CLI installed and `ANTHROPIC_API_KEY` set (or a LiteLLM provider configured). Artifacts are created in `.kody/tasks/` in your project directory. See [CLI reference](CLI.md#run) for all flags.

**Q: Does it work with monorepos?**
Yes. Use `--cwd` to point to the specific package directory. Each package can have its own `kody.config.json`.

**Q: What does `init` do exactly?**
Generates the workflow file (`.github/workflows/kody.yml`) and config (`kody.config.json` with auto-detected quality commands) — deterministically, no LLM needed. Then commits and pushes. Run `@kody bootstrap` next to generate repo-aware step files and labels. See [Configuration](CONFIGURATION.md).

**Q: What does `bootstrap` do?**
Analyzes your codebase with an LLM and generates: project memory (`.kody/memory/` — architecture + conventions), **6 repo-customized step files** (`.kody/steps/` — tailored prompts for each pipeline stage), and 14 GitHub labels for lifecycle tracking. This is required after `init` for a complete setup. See [Bootstrap](BOOTSTRAP.md).

**Q: What are step files (`.kody/steps/`)?**
Customized instruction files for each pipeline stage, generated during `bootstrap`. They contain the engine's default prompt plus three sections specific to your repo: **Repo Patterns** (real code examples to follow), **Improvement Areas** (gaps to fix incrementally), and **Acceptance Criteria** (concrete quality checklist). This means Kody writes code that matches your existing patterns and improves known gaps. See [Features](FEATURES.md#repo-aware-step-files-kodysteps).

**Q: Can I edit the step files?**
Yes. They're plain markdown in `.kody/steps/`. Edit `build.md` to change how Kody writes code, edit `review.md` to change what it checks during review. Changes take effect on the next pipeline run. No engine update needed.

**Q: How do I regenerate step files after a major refactor?**
Run `kody-engine-lite bootstrap --force` (or `@kody bootstrap` on GitHub). This re-analyzes your codebase and produces fresh step files reflecting the current state. Your previous customizations will be overwritten — commit them first if you want to compare.

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

**Q: Can Kody review PRs it didn't create?**
Yes. Comment `@kody review` on any PR for a structured code review (Critical/Major/Minor findings, PASS/FAIL verdict). It submits an actual GitHub review (approve or request-changes). If the review finds issues, run `@kody fix` to auto-fix them. See [Standalone PR Review](FEATURES.md#standalone-pr-review).

**Q: What does `@kody fix` do exactly?**
Re-runs the pipeline from the build stage with three layers of context: (1) Kody's own review findings, (2) human PR comments posted since the last Kody action, and (3) any text you include in the `@kody fix` comment body. Only comments from the current fix cycle are included — already-addressed feedback is excluded. See [PR Feedback for Fix](FEATURES.md#pr-feedback-for-fix).

**Q: What does `@kody fix-ci` do?**
Fetches the failed CI logs (`gh run view --log-failed`), injects them as context, and re-runs from build stage. Auto-triggered when CI fails on a Kody PR, with loop guards: max 1 attempt per 24h, skipped if the last commit was from a bot. Also triggerable manually on any PR. See [Auto Fix-CI](FEATURES.md#auto-fix-ci).

**Q: When does Kody close the issue?**
The ship stage closes the issue immediately after creating the PR — it doesn't wait for the PR to be merged. This is because GitHub's `Closes #N` keyword only auto-closes issues when merging to the default branch, which may not apply if the PR targets a different branch.

**Q: Can `@kody rerun` re-run a completed task?**
Yes. `rerun` and `resolve` bypass the "already-completed" state check, so you can re-run from any stage even after the pipeline has finished. This is useful for iterating on a task without creating a new pipeline run.

**Q: What if taskify fails to produce valid JSON?**
Kody retries once with a stricter prompt. If the output is plain text instead of JSON (e.g., "task already exists"), taskify now handles this gracefully by producing valid JSON with `risk_level=low` instead of crashing the pipeline.

**Q: Can I run multiple issues in parallel?**
Yes. Each issue gets its own GitHub Actions run. The concurrency config is per-task, so different issues run simultaneously.

**Q: Where are artifacts stored?**
In `.kody/tasks/<task-id>/` — includes task.json, plan.md, context.md, verify.md, review.md, ship.md, status.json. These are uploaded as GitHub Actions artifacts (7-day retention).

**Q: What triggers a rerun vs a new run?**
`@kody` always starts a new run with a fresh task ID. `@kody rerun` resumes the last task for that issue from the failed/paused stage.

**Q: How long does a typical pipeline run take?**
Depends on task complexity and model speed. Rough estimates: LOW ~2-5 min, MEDIUM ~5-15 min, HIGH ~15-30 min. Plan and review stages use deep reasoning models which are slower. LiteLLM-proxied models may add latency. Check progress via issue labels and comments.

**Q: What happens if I push changes while Kody is running?**
Kody works on its own feature branch, so your pushes to the default branch won't conflict mid-run. However, if you push to the same branch Kody is using, you may see merge conflicts when Kody tries to push. Best practice: let Kody finish, then push your changes.

**Q: What if the LLM hallucinates or writes bad code?**
The pipeline has multiple safety nets: (1) the verify stage catches type errors, test failures, and lint issues, (2) the review stage runs in a fresh session and can FAIL the code, triggering review-fix, (3) the risk gate pauses HIGH-risk tasks for human approval. Bad code that passes all gates is unlikely but possible — always review PRs before merging.

**Q: Does Kody work with protected branches?**
Yes. Kody creates feature branches and opens PRs — it never pushes directly to protected branches. Add your GitHub Actions bot as a bypass actor in branch protection rules so Kody can push to its own branches. See [Configuration](CONFIGURATION.md#branching-convention).

**Q: Can I run Kody on a private repo?**
Yes. Kody runs entirely in your GitHub Actions environment with your own API keys. No code is sent anywhere except the LLM API you configure.

**Q: How do I see what Kody is doing while it's running?**
Three ways: (1) Watch issue labels change in real-time (`kody:planning` → `kody:building` → etc.), (2) check the GitHub Actions run logs, (3) after completion, inspect artifacts in `.kody/tasks/<task-id>/` (uploaded to Actions with 7-day retention).

## Models

**Q: Which models work with Kody?**
Any model that supports tool use. Anthropic models (haiku/sonnet/opus) are the default. MiniMax M2.7-highspeed is validated for all stages via LiteLLM. See [LiteLLM guide](LITELLM.md).

**Q: How do I switch to a different model (e.g., MiniMax)?**
Set `"provider": "minimax"` in `kody.config.json` — Kody auto-generates the LiteLLM config and starts the proxy. Use `modelMap` for per-tier model control. See [LiteLLM guide](LITELLM.md#setup).

**Q: Can I use different models for different stages?**
Yes. Set different models per tier using the `modelMap` field in `kody.config.json`.

**Q: Can I use local models (Ollama)?**
Yes, via LiteLLM proxy. Set `"provider": "ollama"` in `kody.config.json`. Performance depends on model capability — tool use support is required.

**Q: Why can't I use custom model names like "minimax-test"?**
Claude Code validates `--model` names client-side and only accepts Anthropic model names. Kody automatically maps Anthropic IDs to your provider via LiteLLM. See [LiteLLM guide](LITELLM.md#common-gotchas).

## Security

**Q: Who can trigger Kody?**
Only GitHub collaborators (COLLABORATOR, MEMBER, OWNER). External contributors cannot trigger `@kody`.

**Q: Does Kody have access to my secrets?**
Kody runs in GitHub Actions with the secrets you configure. It has the same access as your CI/CD workflows. It does NOT send code to any service beyond the LLM API.

**Q: Can someone bypass the risk gate?**
Only authorized collaborators can comment `@kody approve`. The gate only fires in CI mode with an issue number, not locally.

**Q: Is the pipeline state safe from corruption?**
State writes are atomic (write-to-tmp + rename). A PID-based lock file prevents concurrent runs on the same task. Session IDs are persisted so reruns resume the correct conversation.
