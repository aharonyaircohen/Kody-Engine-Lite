# Tools

Kody has a generic tool plugin system that lets you declare external tools (test runners, linters, etc.) for pipeline stages. The engine detects tools, runs setup commands, and installs matching skills from [skills.sh](https://skills.sh) — without any tool-specific code in the engine source.

## How It Works

```
Pipeline run starts
  → Engine reads .kody/tools.yml
  → Detects which tools exist in the repo (via file patterns)
  → Runs setup commands before pipeline stages
  → Installs skills from skills.sh (npx skills add <package-ref> --yes)
  → Claude Code loads installed skills natively
```

## Configuration

Tools are declared in `.kody/tools.yml` in your repository. Bootstrap generates a commented-out template:

```yaml
# .kody/tools.yml
playwright:
  detect: ["playwright.config.ts", "playwright.config.js"]
  stages: [verify]
  setup: "npx playwright install --with-deps chromium"
  skill: "microsoft/playwright-cli@playwright-cli"
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `detect` | Yes | File patterns to check in the repo root. If any match, the tool is active. |
| `stages` | Yes | Pipeline stages where this tool is relevant. |
| `setup` | Yes | Shell command to install/prepare the tool. Must be idempotent. Empty string to skip. |
| `skill` | No | skills.sh package reference to install. Find skills at [skills.sh](https://skills.sh). |

### Multiple Tools

```yaml
playwright:
  detect: ["playwright.config.ts"]
  stages: [verify]
  setup: "npx playwright install --with-deps chromium"
  skill: "microsoft/playwright-cli@playwright-cli"

vitest:
  detect: ["vitest.config.ts", "vite.config.ts"]
  stages: [verify, review]
  setup: ""
```

## Skills from skills.sh

When a tool has a `skill` field, the engine installs it from [skills.sh](https://skills.sh) using `npx skills add <package-ref> --yes`. Claude Code loads these skills natively — the engine does not inject skill content into prompts.

To find the right package reference for a tool:
```bash
npx skills find playwright     # search by keyword
npx skills find "react best"   # search by phrase
```

Then use the full `owner/repo@skill-name` reference in your `skill` field.

This means:
- No skill files are shipped with the engine
- No hardcoded tool-to-skill mappings exist in engine source
- Adding a new tool only requires updating `.kody/tools.yml`
- Skills are maintained in the skills.sh ecosystem, not in the engine

## Runtime Behavior

- **Detection** — checks if files from `detect` patterns exist via `fs.existsSync`. Only exact paths, no wildcards.
- **Setup** — runs each tool's `setup` command with a 120-second timeout. Failures log a warning but never abort the pipeline.
- **Skill install** — runs `npx skills add <ref> --yes` for each tool with a `skill` field. Failures log a warning but never abort.
- **No tools configured** — zero overhead. No setup runs, no skills installed.

## CI Caching

Tool setup runs on every pipeline execution. For faster CI runs, cache the tool installation directories in your workflow:

```yaml
- name: Cache Kody tools
  uses: actions/cache@v4
  with:
    path: ~/.cache
    key: kody-tools-${{ hashFiles('.kody/tools.yml') }}
```
