---
name: kody-watch
description: Create and manage Kody Watch agents — LLM-powered autonomous agents that monitor your repository on a cron schedule
version: 1.0.0
---

# Kody Watch — Agent Authoring Guide

Use this skill when you need to **create a new Kody Watch agent**, modify an existing one, or decide whether a watch agent is the right solution for a monitoring problem.

---

## What is a Kody Watch Agent?

A watch agent is an **LLM-powered autonomous agent** that runs on a cron schedule during Kody Watch cycles. Each agent gets a full Claude Code session with filesystem and GitHub tool access — it can read files, run commands, search code, and post GitHub issues.

Use a watch agent when you need:
- Pattern detection across the codebase (not just static analysis)
- Judgment calls about whether something is a problem
- Creating GitHub issues or comments as output
- Adaptive behavior based on repo state

**Don't use a watch agent for:**
- Simple deterministic checks — use a **plugin** instead (e.g. `config-health`, `security-scan`)
- Making direct code changes — watch agents only create issues, never auto-modify code

---

## Agent Structure

Every agent lives in its own folder under `.kody/watch/agents/<name>/`:

```
.kody/watch/agents/<name>/
├── agent.json    # Configuration (name, description, cron, options)
└── agent.md      # System prompt (instructions for the agent)
```

Both files are required. Missing either one skips the agent.

---

## agent.json Reference

```json
{
  "name": "my-agent",
  "description": "One-line description of what this agent does",
  "cron": "0 9 * * 1",
  "reportOnFailure": true,
  "timeoutMs": 3600000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique agent name (kebab-case recommended) |
| `description` | string | yes | One-line description shown in the agents table |
| `cron` | string | yes | Standard 5-field cron expression (UTC). Use [crontab.guru](https://crontab.guru) to verify |
| `reportOnFailure` | boolean | no | Posts agent output to the activity log issue on failure/timeout. Default: `false` |
| `timeoutMs` | number | no | Max runtime in ms. Default: 1,200,000 (20 minutes) |
| `waitFor` | boolean | no | Poll triggered issues for `kody:done`/`kody:failed` labels after agent completes |

### Cron Format

```
┌───────────── minute (0–59)
│ ┌───────────── hour (0–23)
│ │ ┌───────────── day of month (1–31)
│ │ │ ┌───────────── month (1–12)
│ │ │ │ ┌───────────── day of week (0–6, Sun=0)
* * * * *
```

Kody Watch fires every 30 minutes. Your cron fires when the current time falls within a 30-minute window starting at the cron tick.

| Schedule | Cron | Fires |
|----------|------|-------|
| Every cycle | `* * * * *` | Every 30 min |
| Every 6 hours | `0 */6 * * *` | 00:00, 06:00, 12:00, 18:00 UTC |
| Every 12 hours | `0 */12 * * *` | 00:00, 12:00 UTC |
| Daily 09:00 | `0 9 * * *` | 09:00 UTC |
| Monday 09:00 | `0 9 * * 1` | Every Monday 09:00 UTC |
| Sunday 10:00 | `0 10 * * 0` | Every Sunday 10:00 UTC |

---

## agent.md Reference

The `agent.md` file is the **system prompt** injected into the agent's Claude Code session. It describes what the agent should do, how to detect the problem, and how to report findings.

### What the agent automatically receives

- **Context:** repository name, current cycle number, activity log issue number
- **Filesystem:** full repo checkout via Read/Glob/Grep
- **GitHub:** `gh` CLI via Bash — post comments, create issues, search, etc.

### What the agent does NOT automatically get

- Knowledge of other agents or their findings
- Access to previous cycle state (except via state store if configured)
- Ability to modify code — it can only read and report

### Required phases in every agent.md

**1. Pre-flight checks (optional but recommended)**

```bash
# Check for required tools before scanning
command -v tsc >/dev/null 2>&1 || echo "tsc_missing"
```

Skip detection if required tools are missing. Never fail silently — log what was skipped.

**2. Detection**

Run one or more scans to find the target condition. Use `grep`, `gh`, `npx`, or any CLI tool available in the environment.

```bash
# Example: find TODO/FIXME/HACK comments
grep -rn "TODO\|FIXME\|HACK" src/ --include="*.ts" | head -50
```

**3. Check for existing issues (deduplication)**

Before creating anything, check for an existing open issue with your label:

```bash
gh issue list --repo <repo> --state open --label kody:watch:<slug> --json number,title
```

- **Issue exists** → append findings as a comment, don't create a new one
- **No issue** → create one

**4. Aggregate findings**

Count results per category. If **all categories are empty** → log "No findings" and exit silently. **Never create an empty issue.**

**5. Create one consolidated issue**

Create **one issue per cycle** containing all findings. Don't create one issue per finding — that creates noise.

```markdown
## Summary

| Category | Count |
|----------|-------|
| Unused exports | 5 |
| Dead files | 2 |

## Details

<!-- Tables or list of findings -->

---
*Generated by <agent-name> watch agent*
```

### Labeling

Label all created issues with `kody:watch:<slug>` (e.g. `kody:watch:dead-code`). This enables deduplication across cycles.

---

## Writing Good Agent Instructions

### Be specific about detection methods

**Good:**
```bash
npx tsc --noEmit --noUnusedLocals --pretty false 2>&1 | grep "is declared but never used"
```

**Bad:**
```bash
check for unused code
```

### Include dedup logic explicitly

The agent doesn't automatically deduplicate. Tell it to check for existing issues:

```bash
gh issue list --repo <repo> --state open --label kody:watch:<slug> --json number,title
```

### Handle the no-findings case

If nothing is found, the agent should exit silently — no issue to create:

```bash
if [ "$count" -eq 0 ]; then
  echo "No dead code found"
  exit 0
fi
```

### Cap findings per category

For large codebases, cap each category to prevent noisy issues:

```bash
| head -50  # Cap at 50 findings
```

Add a truncation note: "(showing first 50 of N total)"

### Keep issue bodies actionable

Each finding should include:
- File path and line number
- What was found (e.g. the unused export name)
- Why it's a problem (briefly)
- Suggested action

---

## Debugging Agents

### Run locally (dry-run)

```bash
GH_TOKEN=$(gh auth token) kody watch --agent my-agent --dry-run
```

### Run locally (with execution)

```bash
GH_TOKEN=$(gh auth token) kody watch --agent my-agent
```

### Check agent logs

Agent session logs are saved to `.kody/watch/agent-logs/<name>-<timestamp>.log`.

### Test the detection commands first

Before writing the agent.md, run your detection commands manually in the repo to confirm they work:

```bash
# Test in the target repo
grep -rn "TODO\|FIXME" src/ --include="*.ts"
```

---

## Examples

### Minimal agent.json

```json
{
  "name": "unused-exports",
  "description": "Find exported functions that are never used",
  "cron": "0 9 * * 1"
}
```

### agent.md with pre-flight, detection, dedup, and no-op guard

```markdown
## Phase 0 — Pre-flight

Check that required tools are available:
```bash
command -v tsc >/dev/null 2>&1 || echo "tsc_missing"
```

If tsc is missing, exit silently.

## Phase 1 — Scan

Run tsc with unused locals enabled:
```bash
npx tsc --noEmit --noUnusedLocals --pretty false 2>&1 | grep "never used"
```

## Phase 2 — Check for existing issue

```bash
gh issue list --repo {{repo}} --state open --label kody:watch:unused-exports --json number
```

If an issue exists, append to it and stop.

## Phase 3 — No findings

If no results: log "No unused exports found" and exit.

## Phase 4 — Create issue

Create one issue with all findings in a table.
```

---

## Common Patterns

### Checking git history

```bash
# Files not modified in 90 days
git log --since="90 days ago" --name-only --pretty=format: -- src/ | sort -u
```

### Using ESLint/TSC output

```bash
npx eslint src/ --format json 2>/dev/null | \
  jq -r '.[] | select(.messages | length > 0) | .filePath'
```

### Searching for patterns

```bash
# Find files with a specific pattern
grep -rl "TODO\|FIXME" src/ --include="*.ts"
# Count occurrences
grep -rc "FIXME" src/ --include="*.ts" | grep -v ":0$"
```

### Posting a comment

```bash
gh issue comment <number> --body "Updated findings: ..."
```

---

## Quick Reference

| Goal | Command |
|------|---------|
| Create a new agent | Create `.kody/watch/agents/<name>/` with `agent.json` + `agent.md` |
| Test locally (dry-run) | `kody watch --agent <name> --dry-run` |
| Test locally (live) | `kody watch --agent <name>` |
| View agent logs | `.kody/watch/agent-logs/<name>-*.log` |
| Verify cron | [crontab.guru](https://crontab.guru) |
| Check existing issues | `gh issue list --label kody:watch:<slug>` |
