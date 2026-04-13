/**
 * @fileOverview Event System — Hook Configuration
 * @fileType config
 *
 * Maps events to hook configurations.
 * Edit this file to change which hooks fire for which events.
 */

import type { HookConfigMap } from "../hooks/types.js";

export const hookConfig: HookConfigMap = {
  // Pipeline lifecycle
  "pipeline.started": [
    { type: "github-label", labels: ["running"] },
    { type: "log", level: "info" },
  ],
  "pipeline.success": [
    { type: "github-label", labels: ["success"], remove: ["running", "paused"] },
    { type: "log", level: "info" },
  ],
  "pipeline.failed": [
    { type: "github-label", labels: ["failed"], remove: ["running", "paused"] },
    { type: "log", level: "error" },
  ],

  // Step lifecycle
  "step.started": [
    { type: "github-label", labels: ["active"], remove: ["idle"] },
    { type: "log", level: "debug" },
  ],
  "step.waiting": [
    { type: "github-action" },
    { type: "github-label", labels: ["paused"], remove: ["active"] },
    { type: "log" },
  ],
  "step.complete": [
    { type: "log", level: "debug" },
  ],
  "step.failed": [
    { type: "github-label", labels: ["failed"], remove: ["running", "paused"] },
    { type: "log", level: "error" },
  ],

  // Action lifecycle
  "action.cancelled": [
    { type: "github-label", remove: ["running", "paused"] },
    { type: "log", level: "warn" },
  ],

  // User interaction
  "user.response": [
    { type: "github-action" },
    { type: "log", level: "debug" },
  ],

  // PR lifecycle
  "task.pr.created": [
    { type: "github-label", labels: ["pr-open"], remove: ["running"] },
    { type: "log" },
  ],
  "task.pr.merged": [
    { type: "github-label", labels: ["pr-merged"] },
    { type: "log" },
  ],

  // Session completion — creates summary PR
  "session.completed": [
    { type: "github-pr", create: true },
    { type: "github-label", labels: ["session-complete"] },
    { type: "log" },
  ],
};
