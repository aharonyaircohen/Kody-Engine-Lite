# Kody Watch

Periodic health monitoring for your Kody-powered repository. Runs every 30 minutes via GitHub Actions cron, checking pipeline health, security, and configuration. Each agent can also be triggered manually via workflow dispatch using the `--agent` filter.

## How It Works

Kody Watch is a plugin-based watchdog that runs on a fixed 30-minute cron. Each plugin has its own cycle frequency — some run every tick, others run daily. State (cycle counter, dedup timestamps) is persisted as a comment on the activity log issue, so no PAT or special permissions are needed beyond the default `github.token`.

```
Every 30 min
    │
    ├── pipeline-health (every cycle)
    │     └── Scan .kody/tasks/ for stalled, failed, or stuck runs
    │
    ├── security-scan (every 48 cycles ≈ daily)
    │     └── Hardcoded secrets, dependency CVEs, unsafe patterns, committed .env
    │
    └── config-health (every 48 cycles ≈ daily)
          └── Validate kody.config.json, GitHub secrets, quality commands

Manual trigger (workflow_dispatch)
    │
    └── kody watch --agent <name>
          └── Run a single plugin on demand
```

Findings are posted as comments on a pinned **activity log issue** — a single place to monitor your repo's health.

## Setup

### Via `kody init` (recommended)

```bash
kody-engine-lite init
```

Init automatically:
- Installs `.github/workflows/kody-watch.yml`
- Adds `watch: { enabled: true }` to `kody.config.json`

Then run `@kody bootstrap` on a GitHub issue — bootstrap creates the activity log issue, pins it, and sets the `WATCH_ACTIVITY_LOG` repository variable.

### Manual Setup

1. Copy [`templates/kody-watch.yml`](../templates/kody-watch.yml) to `.github/workflows/kody-watch.yml`

2. Add to `kody.config.json`:
   ```json
   {
     "watch": { "enabled": true }
   }
   ```

3. Create a GitHub issue titled `[Kody Watcher] Activity Log` and set the `WATCH_ACTIVITY_LOG` repository variable to its number:
   ```bash
   gh variable set WATCH_ACTIVITY_LOG --repo owner/repo --body "42"
   ```

## Plugins

### pipeline-health

**Cycle:** every 1 (every 30 min)

Discovers `.kody/tasks/*/status.json` files and evaluates each task:

| Health | Condition |
|--------|-----------|
| **stalled** | Running for >30 min without progress |
| **failed** | Pipeline exited with error |
| **healthy** | Running normally or completed |

Posts a comment listing all unhealthy tasks with their status, duration, and failure details.

### security-scan

**Cycle:** every 48 (daily)

Runs four deterministic scans (no LLM, no API keys needed):

| Scan | What it checks | Severity |
|------|---------------|----------|
| Hardcoded secrets | AWS keys, API keys, private keys, JWT tokens in source | critical |
| Dependency vulnerabilities | `npm audit` / `pnpm audit` for critical/high CVEs | high |
| Committed .env files | `.env`, `.env.local`, etc. tracked by git | critical |
| Unsafe code patterns | `eval()`, `innerHTML`, unsanitized `exec` with template literals | high/medium |

Critical findings create individual GitHub issues (max 3 per cycle, deduplicated). All findings are posted to the activity log.

### config-health

**Cycle:** every 48 (daily)

Validates your Kody setup:

- `kody.config.json` exists and is valid JSON
- Required fields set (`github.owner`, `github.repo`)
- Quality commands (`quality.testUnit`) reference existing scripts in `package.json`
- `ANTHROPIC_API_KEY` secret exists
- `.kody/` directory present

## Configuration

```json
{
  "watch": {
    "enabled": true
  }
}
```

That's it. No interval config, no plugin list. The 30-minute tick and plugin schedules are fixed. After bootstrap runs, the config will include the activity log issue number:

```json
{
  "watch": {
    "enabled": true,
    "activityLog": 42
  }
}
```

## Manual Triggering

Use `--agent` to run a single plugin on demand without waiting for the next scheduled tick:

```bash
kody watch --agent pipeline-health
kody watch --agent security-scan
kody watch --agent config-health
```

In GitHub Actions, trigger a specific agent via workflow dispatch on the `kody-watch.yml` workflow, using the `agent` input. This is useful for running an agent immediately from the Actions UI or via `gh workflow run`.

## Local Testing

Run Watch locally with `--dry-run` (no GitHub posts):

```bash
GH_TOKEN=$(gh auth token) kody-engine-lite watch --dry-run
```

Run a single agent manually (also works locally):

```bash
GH_TOKEN=$(gh auth token) kody-engine-lite watch --agent pipeline-health --dry-run
```

## State Persistence

Watch stores its state (cycle number, dedup timestamps) as a hidden HTML comment on the activity log issue:

```html
<!-- KODY_WATCH_STATE:{"system:cycleNumber":47,"watch:dedupEntries":{}} -->
```

This works with the default `github.token` — no PAT or special permissions needed. The state comment is updated in-place on each cycle.

## Deduplication

Actions are deduplicated within a time window to prevent noise:

- **pipeline-health**: 25 min window (slightly less than the 30 min cycle)
- **security-scan**: 23 hours
- **security-scan issues**: 23 hours (also checks for existing open issues before creating)
- **config-health**: 23 hours

Dedup entries older than 24 hours are automatically cleaned up.

## Workflow Permissions

The `kody-watch.yml` workflow needs:

| Permission | Why |
|-----------|-----|
| `issues: write` | Post activity log comments, create security issues |
| `contents: read` | Checkout repo for scanning |

No PAT, no app token, no additional secrets.
