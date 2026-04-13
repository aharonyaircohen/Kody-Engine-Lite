/**
 * @fileOverview Event System — Log Hook
 * @fileType hook-implementation
 *
 * Logs events for development and debugging.
 */

import type { Hook, HookResult, HookContext, HookConfig } from "../types.js";
import type { KodyEvent } from "../../events/types.js";
import { logger } from "../../../logger.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

function toLevel(s?: string): Level {
  if (s && LEVELS.includes(s as Level)) return s as Level;
  return "debug";
}

export const logHook: Hook = {
  handle(event: KodyEvent, _context: HookContext, _config?: HookConfig): HookResult {
    const payload = event.payload as unknown as Record<string, unknown>;
    const level = toLevel(payload.logLevel as string | undefined);
    const msg = `[event] ${event.name} | ${JSON.stringify(event.payload)}`;

    switch (level) {
      case "debug": logger.debug(msg); break;
      case "info":  logger.info(msg);  break;
      case "warn":  logger.warn(msg);  break;
      case "error": logger.error(msg); break;
    }

    return { success: true, hookType: "log", data: { level } };
  },
};
