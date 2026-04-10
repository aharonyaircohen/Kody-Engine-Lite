#!/usr/bin/env bash
# ============================================================
# Kody Engine — Action Poll Script
# ============================================================
# Called by GitHub Actions workflow at each checkpoint.
# Polls the Kody Dashboard for instructions, exits when received.
#
# Required env vars:
#   DASHBOARD_URL        — Kody Dashboard base URL
#   KODY_ACTION_SECRET   — Shared bearer token
#   GITHUB_RUN_ID        — GitHub run ID (run identifier)
#   KODY_RUN_ID          — Kody run/task ID (unique per pipeline)
#
# Optional:
#   KODY_POLL_INTERVAL   — Seconds between polls (default: 10)
#   KODY_POLL_TIMEOUT    — Max seconds to wait (default: 3600 = 1hr)
#   KODY_STEP            — Current step name (e.g. "plan", "build")
# ============================================================

set -euo pipefail

# ─── Defaults ───────────────────────────────────────────────
POLL_INTERVAL="${KODY_POLL_INTERVAL:-10}"
POLL_TIMEOUT="${KODY_POLL_TIMEOUT:-3600}"
DASHBOARD_URL="${DASHBOARD_URL:-}"
KODY_ACTION_SECRET="${KODY_ACTION_SECRET:-}"
GITHUB_RUN_ID="${GITHUB_RUN_ID:-}"
KODY_RUN_ID="${KODY_RUN_ID:-${GITHUB_RUN_ID}}"
KODY_STEP="${KODY_STEP:-unknown}"
ACTION_ID="${KODY_ACTION_ID:-${GITHUB_RUN_ID}}"

# ─── Validate ────────────────────────────────────────────────
if [[ -z "$DASHBOARD_URL" ]]; then
  echo "ERROR: DASHBOARD_URL is not set" >&2
  exit 1
fi

if [[ -z "$KODY_ACTION_SECRET" ]]; then
  echo "ERROR: KODY_ACTION_SECRET is not set" >&2
  exit 1
fi

if [[ -z "$KODY_RUN_ID" ]]; then
  echo "ERROR: KODY_RUN_ID is not set" >&2
  exit 1
fi

HEARTBEAT_URL="${DASHBOARD_URL}/api/kody/action/heartbeat"
POLL_URL="${DASHBOARD_URL}/api/kody/action/poll/${KODY_RUN_ID}"

AUTH_HEADER="Authorization: Bearer ${KODY_ACTION_SECRET}"

echo "[kody-poll] Starting — runId=${KODY_RUN_ID} step=${KODY_STEP} actionId=${ACTION_ID}"
echo "[kody-poll] Dashboard: ${DASHBOARD_URL}"
echo "[kody-poll] Poll interval: ${POLL_INTERVAL}s, timeout: ${POLL_TIMEOUT}s"

# ─── Heartbeat helper ─────────────────────────────────────────
send_heartbeat() {
  curl -s -X POST "$HEARTBEAT_URL" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg runId "$KODY_RUN_ID" \
      --arg actionId "$ACTION_ID" \
      --arg step "$KODY_STEP" \
      --arg status "waiting" \
      '{runId: $runId, actionId: $actionId, step: $step, status: $status}')" \
    || true
}

# ─── Register as waiting ──────────────────────────────────────
echo "[kody-poll] Registering with dashboard..."
send_heartbeat

# ─── Poll loop ───────────────────────────────────────────────
START_TIME=$(date +%s)
LAST_HEARTBEAT=$START_TIME
INSTRUCTION=""

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))

  # Timeout check
  if (( ELAPSED >= POLL_TIMEOUT )); then
    echo "[kody-poll] Timeout reached (${POLL_TIMEOUT}s) — exiting"
    exit 0
  fi

  # Heartbeat every 30s
  if (( NOW - LAST_HEARTBEAT >= 30 )); then
    send_heartbeat
    LAST_HEARTBEAT=$NOW
  fi

  # Poll for instruction
  RESPONSE=$(curl -s -X GET "$POLL_URL" \
    -H "$AUTH_HEADER" \
    --max-time 30 \
    || echo '{"error": "network"}')

  # Check for HTTP errors
  if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    ERROR=$(echo "$RESPONSE" | jq -r '.error')
    echo "[kody-poll] Poll error: $ERROR — retrying in ${POLL_INTERVAL}s"
    sleep "$POLL_INTERVAL"
    continue
  fi

  # Check for takeover
  if echo "$RESPONSE" | jq -e '.takeover == true' > /dev/null 2>&1; then
    echo "[kody-poll] Another instance took over — exiting gracefully"
    exit 0
  fi

  # Check cancel flag
  CANCEL=$(echo "$RESPONSE" | jq -r '.cancel // false')
  if [[ "$CANCEL" == "true" ]]; then
    CANCELLED_BY=$(echo "$RESPONSE" | jq -r '.cancelledBy // "unknown"')
    echo "[kody-poll] Cancelled by ${CANCELLED_BY} — exiting"
    exit 0
  fi

  # Check for instruction
  INSTRUCTION=$(echo "$RESPONSE" | jq -r '.instruction // empty')
  if [[ -n "$INSTRUCTION" && "$INSTRUCTION" != "null" && "$INSTRUCTION" != "empty" ]]; then
    echo "[kody-poll] Received instruction — executing"
    echo "$INSTRUCTION"
    exit 0
  fi

  sleep "$POLL_INTERVAL"
done
