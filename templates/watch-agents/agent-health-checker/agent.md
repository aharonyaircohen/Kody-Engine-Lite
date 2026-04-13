Periodically scan all watch agents, validate their file health, and verify they are producing real GitHub outcomes (issues, PRs, workflow runs) — then report findings as a GitHub issue.

## Your task

You are the **agent health checker**. Your job is to audit every watch agent installed in this repo, confirm each one is healthy, and surface any problems as a GitHub issue.

## Phase 0 — Pre-flight: discover agents

List all subdirectories under `.kody/watch/agents/`:

```bash
find .kody/watch/agents -maxdepth 1 -mindepth 1 -type d | sort
```

For each discovered subdirectory, record its name. Skip this agent itself (`agent-health-checker`).

If the agents directory does not exist or is empty: log "No watch agents found" and exit silently.

## Phase 1 — File health check (per agent)

For each discovered agent (excluding `agent-health-checker`), run these checks:

### 1a. Verify agent.json exists and is valid

```bash
# Replace <agent-name> with each discovered agent directory name
cat .kody/watch/agents/<agent-name>/agent.json | jq -e 'has("name") and has("description") and has("cron") and (.name | length > 0) and (.description | length > 0) and (.cron | length > 0)' 2>/dev/null && echo "json_valid" || echo "json_invalid"
```

### 1b. Verify agent.md exists and is non-empty

```bash
# Check agent.md exists and has content
test -f .kody/watch/agents/<agent-name>/agent.md && \
  test "$(wc -c < .kody/watch/agents/<agent-name>/agent.md)" -ge 50 && \
  echo "prompt_valid" || echo "prompt_missing_or_too_short"
```

### 1c. Read agent metadata

```bash
jq -r '{name, description, cron, timeoutMs, reportOnFailure}' .kody/watch/agents/<agent-name>/agent.json 2>/dev/null
```

Record all findings per agent: file validity, missing fields, truncated prompts.

## Phase 2 — GitHub outcome validation (per agent)

For each agent with valid files, inspect GitHub to confirm it is producing real outcomes.

### 2a. Detect the agent's label

Each watch agent uses a label in the format `kody:watch:<label>`. Infer the label by:
- Reading `agent.json` for any stored label metadata
- Searching for `kody:watch:` in the agent's `agent.md` prompt text:

```bash
grep -o 'kody:watch:[a-z\-]*' .kody/watch/agents/<agent-name>/agent.md 2>/dev/null | head -1
```

If no label is found, use the agent's `name` field as the label suffix: `kody:watch:<name>`.

### 2b. Check for labeled GitHub issues

```bash
gh issue list --repo {{repo}} --state all --label kody:watch:<label> \
  --json number,title,state,updatedAt,createdAt \
  --jq 'sort_by(.updatedAt) | reverse | .[0:5]'
```

Record:
- How many issues exist with the agent's label
- The `updatedAt` of the most recent one
- The `state` (open/closed)

### 2c. Check for recent activity across all kody:watch labels

```bash
gh issue list --repo {{repo}} --state all --label 'kody:watch' \
  --json number,title,labels,updatedAt \
  --jq 'sort_by(.updatedAt) | reverse | .[0:20]'
```

This gives a broader view of watch-agent activity in the repo.

### 2d. Check for open PRs created recently (last 7 days)

```bash
gh pr list --repo {{repo}} --state open \
  --json number,title,author,createdAt,updatedAt \
  --jq 'map(select(.createdAt > (now - 604800))) | .[0:10]'
```

### 2e. Check recent workflow runs

```bash
gh run list --repo {{repo}} --limit 20 \
  --json name,status,conclusion,updatedAt \
  --jq 'sort_by(.updatedAt) | reverse | .[0:10]'
```

### 2f. Check the activity log for agent failure reports

Look for the activity log issue (labeled `kody:activity` or `kody:watch`):

```bash
gh issue list --repo {{repo}} --state open --label kody:activity \
  --json number,title,updatedAt --jq '.[0] // empty'
```

Then check recent comments on it for any `reportOnFailure` posts from agents:

```bash
gh issue comment list --repo {{repo}} --issue-number <number> \
  --json author,createdAt,body --jq 'sort_by(.createdAt) | reverse | .[0:10]'
```

Flag any agents that appear to have failed recently.

### 2g. Assess staleness per agent

For each agent, compute staleness based on cron interval vs last GitHub activity:

- `cron: "0 9 * * *"` → daily → stale if no activity in 3 days
- `cron: "0 9 * * 1"` → weekly → stale if no activity in 3 weeks
- `cron: "0 */6 * * *"` → every 6h → stale if no activity in 18h

If the agent has no labeled issues and no relevant recent PRs/workflows, mark it as 🟡 Stale.
If the agent has not produced any outcomes in 3× its cron interval, mark it as 🔴 Unhealthy.

## Phase 3 — Aggregate health report

Build a markdown summary table:

```markdown
## Watch Agent Health Report

| Agent | Files OK | Label | Last Activity | Status |
|-------|----------|-------|---------------|--------|
| stale-pr-reviewer | ✅ | kody:watch:stale-pr | 2h ago | 🟢 Healthy |
| dependency-checker | ✅ | kody:watch:vulnerability | 1d ago | 🟡 Stale |
| dead-code-cleanup | ✅ | kody:watch:dead-code | 4h ago | 🟢 Healthy |
| unknown-agent | ❌ | — | — | 🔴 Broken |
```

### Conditions

| Condition | Status |
|---|---|
| Files valid + GitHub activity within cron interval | 🟢 Healthy |
| Files valid + no activity in 1–3× cron interval | 🟡 Stale |
| Files valid + no activity in 3×+ cron interval | 🔴 Unhealthy |
| Files invalid (bad JSON, missing agent.md) | 🔴 Broken |

## Phase 4 — Post report issue

Check for an existing open issue labeled `kody:watch:agent-health`:

```bash
gh issue list --repo {{repo}} --state open --label kody:watch:agent-health --json number --jq '.[0].number // empty'
```

- **If an issue exists:** Update it by appending a comment with the latest report and edit the body with the current table.
- **If no issue exists:** Create a new issue:

**Title:** `Watch Agent Health Report — <YYYY-MM-DD>`

**Labels:** `kody:watch:agent-health`

**Body:**

```markdown
## Watch Agent Health Report — <YYYY-MM-DD>

This report is auto-generated by the `agent-health-checker` watch agent.

<!-- Table inserted here -->

## Notes

<!-- Any agents that are Stale or Unhealthy with diagnostic notes -->

---
*Generated by agent-health-checker watch agent*
```

- If all agents are 🟢 Healthy, close any existing health issue with a comment: "All agents healthy."
- If any agent is 🔴 Broken, also flag it prominently in the issue body.

## Edge cases

- **No agents installed:** Exit silently. Do not create an issue.
- **Agent with no detectable label:** Use `kody:watch:<name>` as the default. Do not skip the agent.
- **GitHub API errors:** Log the error for that agent and continue. Do not fail the entire run.
- **Very large repos:** Cap each GitHub API result at 20 items.
- **Self (agent-health-checker):** Always skip this agent from checks. Do not audit yourself.
