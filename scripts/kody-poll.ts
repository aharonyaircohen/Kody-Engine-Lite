/**
 * @fileOverview Kody Engine — Action Poll Script
 * @fileType script
 *
 * Polls the Kody Dashboard for instructions, exits when received or cancelled.
 *
 * Usage: tsx scripts/kody-poll.ts
 *
 * Required env vars:
 *   DASHBOARD_URL        — Kody Dashboard base URL
 *   KODY_ACTION_SECRET   — Shared bearer token
 *   GITHUB_RUN_ID        — GitHub run ID
 *   KODY_RUN_ID          — Kody run/task ID
 *   KODY_STEP            — Current step name
 */

const POLL_INTERVAL = parseInt(process.env.KODY_POLL_INTERVAL ?? "10", 10) * 1000;
const POLL_TIMEOUT = parseInt(process.env.KODY_POLL_TIMEOUT ?? "3600", 10) * 1000;
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "";
const KODY_ACTION_SECRET = process.env.KODY_ACTION_SECRET ?? "";
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID ?? "";
const KODY_RUN_ID = process.env.KODY_RUN_ID ?? GITHUB_RUN_ID;
const KODY_STEP = process.env.KODY_STEP ?? "unknown";
const ACTION_ID = process.env.KODY_ACTION_ID ?? GITHUB_RUN_ID;

if (!DASHBOARD_URL || !KODY_ACTION_SECRET || !KODY_RUN_ID) {
  console.error(
    `[kody-poll] ERROR: Missing required env vars — DASHBOARD_URL=${!!DASHBOARD_URL}, KODY_ACTION_SECRET=${!!KODY_ACTION_SECRET}, KODY_RUN_ID=${!!KODY_RUN_ID}`,
  );
  process.exit(1);
}

const HEARTBEAT_URL = `${DASHBOARD_URL}/api/kody/action/heartbeat`;
const POLL_URL = `${DASHBOARD_URL}/api/kody/action/poll/${KODY_RUN_ID}`;

console.log(`[kody-poll] Starting — runId=${KODY_RUN_ID} step=${KODY_STEP} actionId=${ACTION_ID}`);
console.log(`[kody-poll] Dashboard: ${DASHBOARD_URL}`);
console.log(`[kody-poll] Poll interval: ${POLL_INTERVAL / 1000}s, timeout: ${POLL_TIMEOUT / 1000}s`);

const headers = {
  Authorization: `Bearer ${KODY_ACTION_SECRET}`,
  "Content-Type": "application/json",
};

async function heartbeat(): Promise<void> {
  try {
    await fetch(HEARTBEAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: KODY_RUN_ID, actionId: ACTION_ID, step: KODY_STEP, status: "waiting" }),
    });
  } catch {
    // Non-fatal — continue polling
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(): Promise<void> {
  const startTime = Date.now();
  let lastHeartbeat = startTime;

  console.log("[kody-poll] Registering with dashboard...");
  await heartbeat();

  while (true) {
    const now = Date.now();
    const elapsed = now - startTime;

    // Timeout check
    if (elapsed >= POLL_TIMEOUT) {
      console.log(`[kody-poll] Timeout reached (${POLL_TIMEOUT / 1000}s) — exiting`);
      return;
    }

    // Heartbeat every 30s
    if (now - lastHeartbeat >= 30000) {
      await heartbeat();
      lastHeartbeat = now;
    }

    // Poll
    try {
      const res = await fetch(POLL_URL, {
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        console.log(`[kody-poll] Poll error: HTTP ${res.status} — retrying`);
        await sleep(POLL_INTERVAL);
        continue;
      }

      const data = (await res.json()) as {
        error?: string;
        takeover?: boolean;
        cancel?: boolean;
        cancelledBy?: string;
        instruction?: string;
      };

      if (data.error) {
        console.log(`[kody-poll] Poll error: ${data.error} — retrying`);
        await sleep(POLL_INTERVAL);
        continue;
      }

      if (data.takeover) {
        console.log("[kody-poll] Another instance took over — exiting gracefully");
        return;
      }

      if (data.cancel) {
        console.log(`[kody-poll] Cancelled by ${data.cancelledBy ?? "unknown"} — exiting`);
        return;
      }

      if (data.instruction) {
        console.log("[kody-poll] Received instruction — executing");
        process.stdout.write(data.instruction);
        return;
      }
    } catch (err) {
      console.log(`[kody-poll] Network error: ${err} — retrying`);
    }

    await sleep(POLL_INTERVAL);
  }
}

poll().catch((err) => {
  console.error(`[kody-poll] Unexpected error: ${err}`);
  process.exit(1);
});
