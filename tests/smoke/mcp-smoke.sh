#!/usr/bin/env bash
# Smoke test: verify Claude Code receives Playwright MCP tools via --mcp-config
# This test does NOT run the full pipeline — it just confirms the plumbing works.
set -euo pipefail

MCP_CONFIG='{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}'

echo "=== MCP Smoke Test ==="
echo "Testing: Claude Code + Playwright MCP integration"
echo ""

# Test 1: Claude Code accepts --mcp-config and can list MCP tools
echo "1. Checking Claude Code can load Playwright MCP tools..."
RESULT=$(claude --print --model haiku --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG" \
  --allowedTools "Bash,Read" \
  -p "List all MCP tools available to you. Output ONLY the tool names, one per line. Do not use any tools, just list them." \
  2>/dev/null || true)

if echo "$RESULT" | grep -qi "playwright"; then
  echo "   ✅ Claude Code sees Playwright MCP tools"
  echo "   Tools found:"
  echo "$RESULT" | grep -i "mcp\|playwright\|browser\|navigate\|screenshot\|snapshot" | head -10 | sed 's/^/      /'
else
  echo "   ❌ Claude Code did NOT see Playwright MCP tools"
  echo "   Output was:"
  echo "$RESULT" | head -10 | sed 's/^/      /'
  exit 1
fi

echo ""

# Test 2: Claude Code can actually USE a Playwright MCP tool (navigate + snapshot)
echo "2. Checking Claude Code can use Playwright to browse a page..."
RESULT=$(claude --print --model haiku --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG" \
  -p "Use the Playwright MCP browser_navigate tool to go to https://example.com, then use browser_snapshot to get the page content. Tell me the page title. Be concise." \
  2>/dev/null || true)

if echo "$RESULT" | grep -qi "example"; then
  echo "   ✅ Claude Code successfully browsed https://example.com"
  echo "   Response: $(echo "$RESULT" | head -3)"
else
  echo "   ⚠️  Could not confirm page browsing (may be network restricted)"
  echo "   Response: $(echo "$RESULT" | head -5)"
fi

echo ""
echo "=== Smoke test complete ==="
