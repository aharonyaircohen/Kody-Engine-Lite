# Watch Agents

LLM-powered autonomous agents that run during Kody Watch cycles. Each agent gets a Claude Code session with full tool access to inspect and act on your repository.

## Structure

Each agent lives in its own folder under `.kody/watch/agents/`:

```
.kody/watch/agents/
├── stale-pr-reviewer/
│   ├── agent.json    # Configuration (name, schedule, options)
│   └── agent.md      # System prompt (instructions for the agent)
├── todo-scanner/
│   ├── agent.json
│   └── agent.md
└── README.md         # This file
```

Both `agent.json` and `agent.md` are required — agents missing either file are skipped.

## agent.json Reference

```json
{
  "name": "my-agent",
  "description": "What this agent does",
  "cron": "0 9 * * 1",
  "reportOnFailure": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique agent name |
| `description` | string | yes | Brief description of what the agent monitors |
| `cron` | string | yes | Standard 5-field cron expression (UTC). Use [crontab.guru](https://crontab.guru) to verify. Examples: `"0 9 * * 1"` = Monday 09:00 UTC, `"0 */12 * * *"` = every 12 hours |
| `reportOnFailure` | boolean | no | When `true`, the orchestrator posts the agent's captured output to the activity log issue if the agent fails or times out. Default: `false`. |
| `timeoutMs` | number | no | Agent timeout in milliseconds. Default: 1,200,000 (20 minutes). |

## agent.md Guidelines

The `agent.md` file is the system prompt injected into the agent's Claude Code session. The agent automatically receives:

- **Tools:** `gh` CLI (via Bash), Read, Glob, Grep, and all standard Claude Code tools
- **Context:** Repository name, current cycle number, activity log issue number
- **Environment:** Full checkout of the repository

**Best practices:**

- Be specific about what to check and what actions to take
- Include examples of the `gh` commands the agent should use
- Tell the agent to **check for existing issues before creating new ones** to avoid duplicates
- Label all created issues with a `kody:watch:` prefix (e.g., `kody:watch:stale-pr`)
- The agent owns its own reporting — it can post comments, create issues, etc.
- `reportOnFailure` is a safety net, not a replacement for agent-level reporting

## Built-in Agents

| Agent | Cron | Description |
|-------|------|-------------|
| `stale-pr-reviewer` | `0 9 * * *` (daily 09:00 UTC) | Flag PRs with no activity for 7+ days |
| `todo-scanner` | `0 9 * * *` (daily 09:00 UTC) | Find TODO/FIXME/HACK comments and create tracking issues |
| `branch-cleanup` | `0 9 * * *` (daily 09:00 UTC) | Identify merged branches that can be deleted |
| `dependency-checker` | `0 9 * * *` (daily 09:00 UTC) | Check for outdated dependencies |
| `readme-health` | `0 9 * * *` (daily 09:00 UTC) | Verify README accuracy against code |
| `skill-opportunity-hunter` | `0 10 * * 0` (Sunday 10:00 UTC) | Find patterns worth extracting into Kody skills |
| `dead-code-cleanup` | `0 9 * * 1` (Monday 09:00 UTC) | Find unused exports, dead files, and unreachable code |
| `agent-health-checker` | `0 10 * * *` (daily 10:00 UTC) | Audit all watch agents: validate file health and verify GitHub outcomes |

## Adding a Custom Agent

1. Create a folder: `.kody/watch/agents/my-agent/`
2. Add `agent.json` with name, description, and cron expression
3. Add `agent.md` with instructions for the agent
4. Commit and push — the agent will run on the next matching cron schedule
