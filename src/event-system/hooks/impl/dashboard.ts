/**
 * @fileOverview Event System — Dashboard Hook
 * @fileType hook-implementation
 *
 * Pushes event state to the Kody Dashboard via HTTP.
 * Dashboard URL resolved from KODY_DASHBOARD_ENDPOINTS env var.
 */

import type { Hook, HookResult, HookContext } from "../types.js";
import type { KodyEvent } from "../../events/types.js";
import { parseDashboardEndpoints } from "../../config/environments.js";
import { getActionState } from "../../store/action-state.js";
import { logger } from "../../../logger.js";

export const dashboardHook: Hook = {
  async handle(event: KodyEvent, context: HookContext): Promise<HookResult> {
    const dashboardUrl = context.dashboardUrl;
    if (!dashboardUrl) {
      return { success: true, hookType: "dashboard", data: { skipped: "no dashboardUrl" } };
    }

    const payload = event.payload as unknown as Record<string, unknown>;
    const runId = String(payload.runId ?? "");
    const actionState = runId ? getActionState(runId) : null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${dashboardUrl}/api/kody/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: event.name,
          payload: event.payload,
          actionState: actionState
            ? { status: actionState.status, step: actionState.step, sessionId: actionState.sessionId }
            : null,
          channel: payload.channel ?? "pipeline",
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return {
        success: response.ok,
        hookType: "dashboard",
        data: { status: response.status },
      };
    } catch (err) {
      // Dashboard hook failures are non-fatal
      logger.debug(`[dashboard-hook] non-fatal error: ${err}`);
      return { success: false, hookType: "dashboard", error: String(err) };
    }
  },
};
