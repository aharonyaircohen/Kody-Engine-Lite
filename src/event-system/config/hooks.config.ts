/**
 * @fileOverview Event System — Hook Configuration
 * @fileType config
 *
 * Maps events to hook configurations.
 * Edit this file to change which hooks fire for which events.
 *
 * The "webhook" hook POSTs a normalized event payload to KODY_WEBHOOK_URL
 * (optionally authenticated with KODY_WEBHOOK_TOKEN Bearer token).
 * It fires silently (skipped) when no URL is configured.
 */

import type { HookConfigMap } from "../hooks/types.js";

export const hookConfig: HookConfigMap = {
  // Pipeline lifecycle
  "pipeline.started": [
    { type: "github-label", labels: ["running"] },
    { type: "log", level: "info" },
    { type: "webhook" },
  ],
  "pipeline.success": [
    { type: "github-label", labels: ["success"], remove: ["running", "paused"] },
    { type: "log", level: "info" },
    { type: "webhook" },
  ],
  "pipeline.failed": [
    { type: "github-label", labels: ["failed"], remove: ["running", "paused"] },
    { type: "log", level: "error" },
    { type: "webhook" },
  ],

  // Step lifecycle
  "step.started": [
    { type: "github-label", labels: ["active"], remove: ["idle"] },
    { type: "log", level: "debug" },
    { type: "webhook" },
  ],
  "step.waiting": [
    { type: "github-action" },
    { type: "github-label", labels: ["paused"], remove: ["active"] },
    { type: "log" },
    { type: "webhook" },
  ],
  "step.complete": [
    { type: "log", level: "debug" },
    { type: "webhook" },
  ],
  "step.failed": [
    { type: "github-label", labels: ["failed"], remove: ["running", "paused"] },
    { type: "log", level: "error" },
    { type: "webhook" },
  ],

  // Action lifecycle
  "action.cancelled": [
    { type: "github-label", remove: ["running", "paused"] },
    { type: "log", level: "warn" },
    { type: "webhook" },
  ],

  // User interaction
  "user.response": [
    { type: "github-action" },
    { type: "log", level: "debug" },
    { type: "webhook" },
  ],

  // PR lifecycle
  "task.pr.created": [
    { type: "github-label", labels: ["pr-open"], remove: ["running"] },
    { type: "log" },
    { type: "webhook" },
  ],
  "task.pr.merged": [
    { type: "github-label", labels: ["pr-merged"] },
    { type: "log" },
    { type: "webhook" },
  ],

  // Session completion — creates summary PR
  "session.completed": [
    { type: "github-pr", create: true },
    { type: "github-label", labels: ["session-complete"] },
    { type: "log" },
    { type: "webhook" },
  ],

  // Chat events
  "chat.message": [
    { type: "webhook" },
  ],
  "chat.done": [
    { type: "webhook" },
  ],
  "chat.error": [
    { type: "log", level: "error" },
    { type: "webhook" },
  ],
};
