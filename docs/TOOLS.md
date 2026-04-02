# Tools

Kody has a generic tool plugin system that lets you declare external tools (test runners, linters, etc.) for pipeline stages. The engine detects, installs, and injects tool knowledge into the AI agent's prompt — without any tool-specific code in the engine source.

## How It Works

```
Pipeline run starts
  → Engine reads .kody/tools.yml
  → Detects which tools exist in the repo (via file patterns)
  → Runs setup commands before pipeline stages
  → Injects tool skill content into matching stage prompts
  → AI agent uses the tool when relevant
```

## Configuration

Tools are declared in `.kody/tools.yml` in your repository. Bootstrap generates a commented-out template:

```yaml
# .kody/tools.yml
playwright:
  detect: ["playwright.config.ts", "playwright.config.js"]
  stages: [verify]
  setup: "npx playwright install --with-deps chromium"
  skill: playwright-cli.md
```

### Fields

| Field | Description |
|-------|-------------|
| `detect` | File patterns to check in the repo root. If any match, the tool is active. |
| `stages` | Pipeline stages that receive the tool's skill content in their prompt. |
| `setup` | Shell command to run before stages begin. Must be idempotent (safe to re-run). |
| `skill` | Filename of a markdown skill file that teaches the AI agent how to use the tool. |

### Multiple Tools

```yaml
playwright:
  detect: ["playwright.config.ts"]
  stages: [verify]
  setup: "npx playwright install --with-deps chromium"
  skill: playwright-cli.md

vitest:
  detect: ["vitest.config.ts", "vite.config.ts"]
  stages: [verify, review]
  setup: ""
  skill: vitest.md
```

## Skill Files

Skill files teach the AI agent **when and how** to use a tool. They're written as directives, not passive documentation.

### Resolution Order

1. `.kody/skills/{filename}` in your repo (project-level override)
2. `skills/{filename}` shipped with the engine (built-in defaults)

### Writing a Skill File

A good skill file:
- Tells the agent it has the tool available
- Explains when to use it
- Shows common commands and patterns
- Describes how to read and debug failures

The engine ships `playwright-cli.md` as a built-in skill. Override it by creating `.kody/skills/playwright-cli.md` in your repo.

## Runtime Behavior

- **Detection** — checks if files from `detect` patterns exist via `fs.existsSync`. Only exact paths, no wildcards.
- **Setup** — runs each tool's `setup` command with a 120-second timeout. Failures log a warning but never abort the pipeline.
- **Injection** — matched tools' skill content is appended to the stage prompt under an `## Available Tools` section. The agent sees it as part of its instructions.
- **No tools configured** — zero overhead. No setup runs, no skills injected.

## CI Caching

Tool setup runs on every pipeline execution. For faster CI runs, cache the tool installation directories in your workflow:

```yaml
- name: Cache Kody tools
  uses: actions/cache@v4
  with:
    path: ~/.cache
    key: kody-tools-${{ hashFiles('.kody/tools.yml') }}
```

## Available Built-in Skills

| Skill File | Tool | Description |
|-----------|------|-------------|
| `playwright-cli.md` | Playwright | Running E2E tests, debugging failures, common CLI patterns |
