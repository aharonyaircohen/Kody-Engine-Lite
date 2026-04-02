# Tools & Skills — Developer Guide

This document captures the architecture decisions and conventions for how Kody Engine Lite handles external tools and AI agent skills. It is the source of truth for any agent or developer working on these systems.

## Core Principle

**The engine is generic.** It has zero knowledge of specific tools (Playwright, Vitest, ESLint) or specific skills. All tool and skill knowledge lives outside the engine source — in user config and skills.sh.

## Two Separate Systems

### Tools (`.kody/tools.yml`)

**What:** External executables the pipeline needs to run — test runners, linters, browser automation, etc.

**Responsibility:** Detection and setup only. "Is this tool needed?" and "Install it."

```yaml
# .kody/tools.yml — lives in the target repo, sole source of truth
playwright:
  detect: ["playwright.config.ts", "playwright.config.js"]
  stages: [verify]
  setup: "npx playwright install --with-deps chromium"
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `detect` | Yes | File patterns to check in repo. If any exist, tool is active. |
| `stages` | Yes | Pipeline stages where this tool is relevant. |
| `setup` | Yes | Shell command to install/prepare the tool. Must be idempotent. |

**Runtime flow:**
1. Engine reads `.kody/tools.yml`
2. Checks `detect` patterns via `fs.existsSync`
3. Runs `setup` commands before pipeline stages (120s timeout, non-fatal on failure)
4. That's it. No skill injection, no prompt modification.

### Skills (skills.sh)

**What:** Knowledge files that teach the AI agent how to use tools, frameworks, and patterns. Markdown files installed from [skills.sh](https://skills.sh).

**Responsibility:** Agent knowledge. "How do I use Playwright?" "What are React best practices?"

**How they work:**
- Installed via `npx skills add` into `.claude/skills/` or `.agents/skills/`
- Claude Code loads them natively — the engine does NOT inject them into prompts
- The engine does NOT ship any skill files

**Two installation triggers:**

| Trigger | What it detects | Example |
|---------|----------------|---------|
| **Bootstrap** | Repo architecture (frameworks, languages) | React detected → install React best practices skill |
| **Tool setup** | Tool name from `tools.yml` | `playwright` tool → install `playwright` skill from skills.sh |

**Skill resolution for tools:** Match by exact tool name on skills.sh. If the tool is named `playwright`, the engine runs `npx skills add --skill playwright`. No hardcoded mappings.

## What the Engine Does NOT Do

- Ship skill files (no `skills/` directory in the package)
- Hardcode tool-to-skill mappings in source code
- Inject skill content into prompts (Claude Code handles this natively)
- Know about specific tools or skills by name
- Have a `defaults/tools.yml` or default tool declarations

## Decision Log

| Decision | Choice | Why |
|----------|--------|-----|
| Tool declarations location | `.kody/tools.yml` only | Single source of truth, no merge complexity |
| Skill source | skills.sh exclusively | Standard ecosystem, no engine-shipped skills |
| Skill installation | `npx skills add` | Same mechanism for all skills, generic |
| Skill-to-tool mapping | Exact name match on skills.sh | Simple, no hardcoded lookup tables |
| Prompt injection | None — Claude Code loads skills natively | Engine stays out of the skill business |
| Setup failure | Log warning, continue pipeline | Optional tooling should never block work |
| Detection | `fs.existsSync` for exact paths | Simple, sufficient for v1 |
| Bootstrap template | Commented-out example | User opts in explicitly |
| Hardcoded `skills.ts` | Remove | Violates "engine is generic" principle |

## File Ownership

| File | Owner | Purpose |
|------|-------|---------|
| `src/tools.ts` | Engine | Generic: load, detect, setup tools |
| `src/bin/skills.ts` | **DELETE** | Was hardcoded skill mappings — replaced by tools.yml + skills.sh |
| `skills/` | **DELETE** | Was engine-shipped skills — replaced by skills.sh |
| `.kody/tools.yml` | Target repo | User declares their tools |
| `.claude/skills/` | Target repo | skills.sh installs skills here |
| `.agents/skills/` | Target repo | skills.sh installs skills here |

## Adding a New Tool (User Flow)

1. Edit `.kody/tools.yml`:
   ```yaml
   cypress:
     detect: ["cypress.config.ts"]
     stages: [verify]
     setup: "npx cypress install"
   ```
2. Commit and push
3. Next pipeline run: engine detects Cypress, runs setup, installs matching skill from skills.sh
4. No engine release needed

## Adding a New Built-in Skill (Wrong)

Don't. Skills come from skills.sh. If a skill doesn't exist on skills.sh for a tool, create it there — not in the engine.
