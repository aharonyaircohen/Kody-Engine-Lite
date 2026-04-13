/**
 * @fileOverview Event System — GitHub PR Hook
 * @fileType hook-implementation
 *
 * Creates PRs for tasks and session summaries.
 * Uses the engine's existing github-api.ts functions.
 */

import type { Hook, HookResult, HookContext, HookConfig } from "../types.js";
import type { KodyEvent } from "../../events/types.js";
import { createPR } from "../../../github-api.js";
import { upsertPRState, getPRStatesBySession, markPRCreated } from "../../store/pr-state.js";
import { logger } from "../../../logger.js";

export const githubPrHook: Hook = {
  handle(event: KodyEvent, _context: HookContext, _config?: HookConfig): HookResult {
    const payload = event.payload as unknown as Record<string, unknown>;

    try {
      // ── task.pr.created ───────────────────────────────────────────────
      if (event.name === "task.pr.created") {
        const prNumber = Number(payload.prNumber);
        const prUrl = String(payload.prUrl ?? "");
        const runId = String(payload.runId ?? "");
        if (prNumber && runId) {
          markPRCreated(runId, prNumber, prUrl);
        }
        return { success: true, hookType: "github-pr", data: { prNumber, prUrl } };
      }

      // ── session.completed ─────────────────────────────────────────────
      if (event.name === "session.completed") {
        const runId = String(payload.runId ?? "");
        const sessionId = String(payload.sessionId ?? "");
        const taskPrs = getPRStatesBySession(sessionId);

        const taskList = taskPrs
          .map((pr) => {
            const emoji = pr.status === "merged" ? "✅" : pr.status === "open" ? "🔄" : "⏳";
            const link = pr.prNumber ? `#${pr.prNumber}` : "—";
            return `## ${pr.title || pr.taskId || "Task"}\nStatus: ${emoji} ${pr.status} | ${link}`;
          })
          .join("\n\n");

        const branchName = `session-summary-${sessionId}-${Date.now()}`;
        const body = [
          `## Session Summary\n`,
          `**Session:** ${sessionId}`,
          `**Run:** ${runId}`,
          `**Tasks:** ${taskPrs.length}`,
          ``,
          taskList || "_No task PRs created_",
        ].join("\n");

        upsertPRState({
          runId,
          sessionId,
          title: `Session Summary — ${sessionId}`,
          body,
          head: branchName,
          status: "pending",
        });

        try {
          const pr = createPR(branchName, "main", `Session Summary — ${sessionId}`, body);
          if (pr) {
            markPRCreated(runId, pr.number, pr.url);
            return {
              success: true,
              hookType: "github-pr",
              data: { prNumber: pr.number, prUrl: pr.url },
            };
          }
          return { success: false, hookType: "github-pr", error: "createPR returned null" };
        } catch (err) {
          logger.debug(`[github-pr] createPR error: ${err}`);
          return { success: false, hookType: "github-pr", error: String(err) };
        }
      }

      return { success: true, hookType: "github-pr", data: { skipped: true } };
    } catch (err) {
      logger.debug(`[github-pr] Error: ${err}`);
      return { success: false, hookType: "github-pr", error: String(err) };
    }
  },
};
