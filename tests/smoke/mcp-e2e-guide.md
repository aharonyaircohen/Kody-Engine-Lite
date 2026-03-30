# MCP Browser Integration — E2E Testing Guide

## Prerequisites
- Node.js >= 22
- Non-root user (Chromium sandbox requirement) OR `--no-sandbox` flag
- A project with UI (React, Next.js, Vue, etc.)

## Quick Validation (no project needed)

```bash
# 1. Verify Claude Code sees MCP tools
MCP_CONFIG='{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}'

claude --print --model haiku --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG" \
  -p "List all MCP tools available to you that contain 'browser' in the name."
```

Expected: List of ~20 tools like `mcp__playwright__browser_navigate`, `mcp__playwright__browser_snapshot`, etc.

```bash
# 2. Verify browsing works
claude --print --model haiku --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG" \
  -p "Navigate to https://example.com and tell me the page title."
```

Expected: "Example Domain"

## Full Pipeline Test

### Step 1: Set up a test project with UI

```bash
npx create-next-app@latest test-ui-project --ts --app --no-tailwind --no-eslint
cd test-ui-project
git init && git add -A && git commit -m "init"
```

### Step 2: Add Kody config with MCP

```bash
cat > kody.config.json << 'EOF'
{
  "quality": {
    "typecheck": "npx tsc --noEmit",
    "testUnit": "npx vitest run"
  },
  "git": { "defaultBranch": "main" },
  "github": { "owner": "your-org", "repo": "test-ui-project" },
  "agent": {
    "modelMap": { "cheap": "haiku", "mid": "sonnet", "strong": "opus" }
  },
  "mcp": {
    "enabled": true,
    "servers": {
      "playwright": {
        "command": "npx",
        "args": ["@playwright/mcp@latest"]
      }
    },
    "stages": ["build", "review"]
  }
}
EOF
```

### Step 3: Create a UI-focused issue

Create a GitHub issue like:
> **Add a counter component to the home page**
> Add a button that increments a counter. Display the current count above the button.

### Step 4: Run Kody

```bash
kody-engine-lite run --issue 1
```

### What to verify:
1. **taskify** produces `task.json` with `"hasUI": true`
2. **build** stage log shows `MCP servers enabled for build`
3. Claude Code uses `browser_navigate` to `http://localhost:3000` and `browser_snapshot` to verify the UI
4. **review** stage log shows `MCP servers enabled for review`
5. Review includes visual verification notes

### Step 5: Run just the build stage (faster iteration)

```bash
kody-engine-lite rerun --issue 1 --from build
```

## Troubleshooting

### "Cannot launch browser" / sandbox errors
- Run as non-root user, OR
- Use Playwright with `--no-sandbox`: change args to `["@playwright/mcp@latest", "--no-sandbox"]`

### MCP tools not appearing
- Check `kody.config.json` has `"enabled": true`
- Check the stage is in the `stages` array
- Run the quick validation above to isolate whether it's a config or Claude Code issue

### Browser tools not used during build
- Check `task.json` — if `hasUI: false`, browser guidance is suppressed
- Check the build prompt output (`.kody/tasks/{id}/`) for "Browser Tools Available" section
- The agent may choose not to use browser tools if the task is simple enough
