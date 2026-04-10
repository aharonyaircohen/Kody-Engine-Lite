/**
 * @fileOverview Event System — Hook Registry
 * @fileType core
 *
 * Loads hook config, resolves to implementations, fires hooks
 * with per-hook failure isolation.
 */

import type { KodyEvent } from "../events/types.js";
import type { Hook, HookResult, HookContext, HookConfig, HookType } from "./types.js";
import { hookConfig } from "../config/hooks.config.js";
import { updateLastEntry } from "../store/event-log.js";
import { logger } from "../../logger.js";

// ─── Hook Implementation Registry ───────────────────────────────────────────

const impls: Partial<Record<HookType, () => Promise<Hook>>> = {
  "github-label": () => import("./impl/github-label.js").then((m) => m.githubLabelHook),
  "github-pr": () => import("./impl/github-pr.js").then((m) => m.githubPrHook),
  "dashboard": () => import("./impl/dashboard.js").then((m) => m.dashboardHook),
  "log": () => import("./impl/log.js").then((m) => m.logHook),
};

export class HookRegistry {
  private cache = new Map<HookType, Hook>();

  private async getImpl(type: HookType): Promise<Hook | null> {
    if (this.cache.has(type)) return this.cache.get(type)!;
    const loader = impls[type];
    if (!loader) return null;
    const hook = await loader();
    this.cache.set(type, hook);
    return hook;
  }

  /** Fire all hooks registered for an event. Failures are isolated per hook. */
  async fire(event: KodyEvent, context: HookContext): Promise<HookResult[]> {
    const configs = hookConfig[event.name] ?? [];
    if (!configs.length) return [];

    const results: HookResult[] = [];

    for (const config of configs) {
      // github-action hook — no-op here; handled externally by polling
      if (config.type === "github-action") {
        results.push({ success: true, hookType: "github-action", data: { skipped: true } });
        continue;
      }

      const impl = await this.getImpl(config.type);
      if (!impl) {
        logger.debug(`[hook-registry] No impl for: ${config.type}`);
        results.push({ success: false, hookType: config.type, error: `No implementation: ${config.type}` });
        continue;
      }

      try {
        const result = await impl.handle(event, context);
        results.push(result);
      } catch (err) {
        // Per-hook failure isolation — one crashing doesn't stop others
        logger.debug(`[hook-registry] "${config.type}" threw: ${err}`);
        results.push({ success: false, hookType: config.type, error: String(err) });
      }
    }

    // Update event log with hook results
    const hooksFired: string[] = [];
    const hookErrors: Record<string, string> = {};
    for (const r of results) {
      hooksFired.push(r.hookType);
      if (r.error) hookErrors[r.hookType] = r.error;
    }
    updateLastEntry(hooksFired, hookErrors);

    return results;
  }
}

export const registry = new HookRegistry();
