# Tools & Skills — Developer Guide

This document captures the architecture decisions and conventions for how Kody Engine Lite handles external tools and AI agent skills. It is the source of truth for any agent or developer working on these systems.

## Core Principle

**The engine is generic.** It has zero knowledge of specific tools (Playwright, Vitest, ESLint) or specific skills. All tool and skill knowledge lives outside the engine source — in user config and skills.sh.

## Two Separate Systems

### Tools (`.kody/tools.yml`)

**What:** External executables the pipeline needs to run — test runners, linters, browser automation, etc.

**Responsibility:** Detection, setup, and skill installation.

```yaml
# .kody/tools.yml — lives in the target repo, sole source of truth
playwright:
  detect: ["playwright.config.ts", "playwright.config.js"]
  stages: [verify]
  setup: "npx playwright install --with-deps chromium"
  skill: "microsoft/playwright-cli@playwright-cli"
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `detect` | Yes | File patterns to check in repo. If any exist, tool is active. |
| `stages` | Yes | Pipeline stages where this tool is relevant. |
| `setup` | Yes | Shell command to install/prepare the tool. Must be idempotent. |
| `skill` | No | skills.sh package reference (`owner/repo@skill-name`). Installed via `npx skills add`. |

**Runtime flow:**
1. Engine reads `.kody/tools.yml`
2. Checks `detect` patterns via `fs.existsSync`
3. Runs `setup` commands before pipeline stages (120s timeout, non-fatal on failure)
4. If `skill` is set, runs `npx skills add <ref> --yes` (60s timeout, non-fatal on failure)

### Skills (skills.sh)

**What:** Knowledge files that teach the AI agent how to use tools, frameworks, and patterns. Markdown files installed from [skills.sh](https://skills.sh).

**Responsibility:** Agent knowledge. "How do I use Playwright?" "What are React best practices?"

**How they work:**
- Installed via `npx skills add` into `.claude/skills/` or `.agents/skills/`
- Claude Code loads them natively — the engine does NOT inject them into prompts
- The engine does NOT ship any skill files

**Installation trigger:** The `skill` field in `.kody/tools.yml`. When a detected tool has a `skill` field, the engine runs `npx skills add <package-ref> --yes`. No `skill` field = no skill installed.

**Finding the right skill:**
```bash
npx skills find playwright        # search by keyword
npx skills find "react best"      # search by phrase
```
Use the `owner/repo@skill-name` from the results as the `skill` field value.

## What the Engine Does NOT Do

- Hardcode tool-to-skill mappings in source code
- Inject skill content into prompts (Claude Code handles this natively)
- Know about specific tools or skills by name
- Auto-search skills.sh to guess which skill to install
- Have a `defaults/tools.yml` or default tool declarations

> **Exception:** The engine ships one bundled skill — `templates/skills/kody/SKILL.md` — installed via `kody init` into `.claude/skills/kody/`. This skill teaches the agent how to write Kody-ready issues and interact with the pipeline. It is the only engine-shipped skill; all other skills come from skills.sh.

## Decision Log

| Decision | Choice | Why |
|----------|--------|-----|
| Tool declarations location | `.kody/tools.yml` only | Single source of truth, no merge complexity |
| Skill source | skills.sh + one bundled exception | Standard ecosystem; Kody skill is bundled intentionally for self-referential use |
| Skill installation | `npx skills add` via `skill` field | Explicit package ref, no auto-search guessing |
| Prompt injection | None — Claude Code loads skills natively | Engine stays out of the skill business |
| Setup/skill failure | Log warning, continue pipeline | Optional tooling should never block work |
| Detection | `fs.existsSync` for exact paths | Simple, sufficient for v1 |
| Bootstrap template | Commented-out example with skill ref | User opts in explicitly |
| Hardcoded `skills.ts` | Removed | Violated "engine is generic" principle |

## File Ownership

| File | Owner | Purpose |
|------|-------|---------|
| `src/tools.ts` | Engine | Generic: load, detect, setup tools, install skills |
| `.kody/tools.yml` | Target repo | User declares their tools and skill refs |
| `.claude/skills/` | Target repo | skills.sh installs skills here |
| `.agents/skills/` | Target repo | skills.sh installs skills here |
| `templates/skills/` | Engine | Bundled skills installed by `kody init` into target repos |

## Adding a New Tool (User Flow)

1. Find the skill on skills.sh: `npx skills find cypress`
2. Edit `.kody/tools.yml`:
   ```yaml
   cypress:
     detect: ["cypress.config.ts"]
     stages: [verify]
     setup: "npx cypress install"
     skill: "some-org/cypress-skill@cypress"
   ```
3. Commit and push
4. Next pipeline run: engine detects Cypress, runs setup, installs skill
5. No engine release needed

## Adding a New Built-in Skill (Wrong)

Don't — unless it's the Kody self-referential skill. Skills come from skills.sh. If a skill doesn't exist on skills.sh for a tool, create it there — not in the engine.

The one exception is `templates/skills/kody/SKILL.md`, which teaches the agent to interact with the Kody pipeline itself. This is self-referential by design and cannot come from skills.sh. Add new bundled skills to `templates/skills/` and update `src/bin/commands/init.ts` to install them.
