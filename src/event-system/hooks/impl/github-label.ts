/**
 * @fileOverview Event System — GitHub Label Hook
 * @fileType hook-implementation
 */

import type { Hook, HookResult, HookContext, HookConfig } from "../types.js";
import type { KodyEvent } from "../../events/types.js";
import { setLabel, removeLabel } from "../../../github-api.js";
import { logger } from "../../../logger.js";

export const githubLabelHook: Hook = {
  handle(event: KodyEvent, context: HookContext, _config?: HookConfig): HookResult {
    const p = event.payload as unknown as Record<string, unknown>;
    const issueNumber = context.issueNumber ?? (p.issueNumber as number | undefined);
    if (!issueNumber) return { success: true, hookType: "github-label", data: { skipped: "no issueNumber" } };

    const labels = p.labels as string[] | undefined;
    const remove = p.remove as string[] | undefined;

    try {
      if (remove?.length) {
        for (const label of remove) {
          try { removeLabel(issueNumber, label); } catch { /* label may not exist */ }
        }
      }
      if (labels?.length) {
        for (const label of labels) {
          try { setLabel(issueNumber, label); } catch { /* already set */ }
        }
      }
      return { success: true, hookType: "github-label", data: { added: labels, removed: remove } };
    } catch (err) {
      logger.debug(`[github-label] Error: ${err}`);
      return { success: false, hookType: "github-label", error: String(err) };
    }
  },
};
