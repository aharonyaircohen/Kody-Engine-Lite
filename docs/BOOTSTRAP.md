# Bootstrap

Bootstrap generates project-specific memory and pipeline step files by analyzing your codebase with an LLM. It also creates the GitHub labels Kody uses for lifecycle tracking.

> **Bootstrap is required.** After `kody init` sets up the workflow and config, you must run `@kody bootstrap` (or `kody-engine-lite bootstrap` locally) to generate project memory and customized step files. Without bootstrap, Kody runs with generic prompts instead of repo-aware ones.

## When to Run

- **First time:** After `kody-engine-lite init` — required for a complete setup.
- **After major refactors:** Re-run to regenerate memory and step files from the current state of your codebase.
- **After config changes:** If you change frameworks, testing tools, or project structure.

## How to Trigger

### Via GitHub Issue Comment

```
@kody bootstrap
```

This runs in GitHub Actions where `GITHUB_TOKEN` is already available — no local CLI setup required.

### Via CLI (in CI)

```bash
kody-engine-lite bootstrap
```

Typically runs inside GitHub Actions. Can also run locally if `gh` CLI is authenticated.

### Override Model

Use `--provider` and `--model` flags to override the configured LLM for bootstrap:

```bash
kody-engine-lite bootstrap --provider=claude --model=claude-opus-4-6
```

This overrides the model resolved from `kody.config.json` for this run only.

## What It Does

### Step 1: Generate Project Memory

Analyzes your codebase (package.json, tsconfig, README, CLAUDE.md, source files, directory structure) and generates:

- `.kody/memory/architecture.md` — framework, language, database, testing, key directories, data flow
- `.kody/memory/conventions.md` — naming patterns, file organization, error handling, testing conventions

### Step 2: Generate Step Files

Creates customized pipeline prompt files in `.kody/steps/`:

| File | Controls |
|------|----------|
| `taskify.md` | How tasks are classified and scoped |
| `plan.md` | Planning guidelines for your architecture |
| `build.md` | Coding instructions with your patterns as examples |
| `autofix.md` | How to fix verification failures with your toolchain |
| `review.md` | Review checklist calibrated to your quality bar |
| `review-fix.md` | How to address review findings |

Each step file includes three repo-specific sections:
- **Repo Patterns** — real code examples showing what "good" looks like in your project
- **Improvement Areas** — gaps and anti-patterns to fix incrementally
- **Acceptance Criteria** — concrete checklist defining "done" for each stage

### Step 2b: Generate QA Guide

If the project has discoverable routes or collections (e.g., Next.js pages, Payload CMS collections), bootstrap generates a QA guide at `.kody/qa-guide.md` with authentication steps, navigation maps, and verification patterns.

### Step 2c: Generate Tools Template

Creates `.kody/tools.yml` with a commented-out Playwright example. Uncomment and configure tools your project uses. See [Tools](TOOLS.md) for the full reference.

### Step 3: Create Labels

Creates 14 GitHub labels used for lifecycle tracking:

| Category | Labels |
|----------|--------|
| **Lifecycle** | `kody:planning`, `kody:building`, `kody:review`, `kody:done`, `kody:failed`, `kody:waiting` |
| **Complexity** | `kody:low`, `kody:medium`, `kody:high` |
| **Work Type** | `kody:feature`, `kody:bugfix`, `kody:refactor`, `kody:docs`, `kody:chore` |

Labels are created with `--force`, so re-running bootstrap safely updates existing labels.

### Step 4: Commit and Push

- **In CI (GitHub Actions):** Creates a new branch (`kody-bootstrap-<timestamp>`), commits files, pushes, and opens a PR.
- **Locally:** Commits to the current branch and pushes.

## Output

After bootstrap completes, your repo will have:

```
.kody/
├── memory/
│   ├── architecture.md
│   └── conventions.md
├── steps/
│   ├── taskify.md
│   ├── plan.md
│   ├── build.md
│   ├── autofix.md
│   ├── review.md
│   └── review-fix.md
├── qa-guide.md
└── tools.yml
```

## Re-running Bootstrap

Bootstrap is idempotent — running it again regenerates all files from scratch. Use `@kody bootstrap` on an issue anytime you want to refresh project memory and step files.
