/**
 * @fileOverview Event System — Webhook Hook
 * @fileType hook-implementation
 *
 * POSTs a normalized event payload to a configurable HTTP endpoint.
 *
 * Configuration (env vars, or hook config overrides):
 *   KODY_WEBHOOK_URL   — endpoint to POST to (e.g. https://my-dashboard.com/api/webhook)
 *   KODY_WEBHOOK_TOKEN — optional Bearer token for auth
 *
 * The hook is silent (skipped) when no URL is configured — zero noise.
 * Failures are isolated: a failed POST does not stop other hooks.
 */

import type { Hook, HookResult, HookContext, WebhookHookConfig } from "../types.js";
import type { KodyEvent, EventName } from "../../events/types.js";
import { logger } from "../../../logger.js";

const WEBHOOK_TIMEOUT_MS = 10_000;

interface NormalizedPayload {
  eventId: string;
  eventName: EventName;
  emittedAt: string;
  runId: string;
  sessionId?: string;
  issueNumber?: number;
  payload: Record<string, unknown>;
}

function getUrl(config: WebhookHookConfig | undefined): string | undefined {
  // Config overrides env var; env var is the default
  return config?.url ?? process.env.KODY_WEBHOOK_URL;
}

function getToken(config: WebhookHookConfig | undefined): string | undefined {
  return config?.token ?? process.env.KODY_WEBHOOK_TOKEN;
}

function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildPayload(event: KodyEvent, runId: string): NormalizedPayload {
  const payload = event.payload as unknown as Record<string, unknown>;
  return {
    eventId: generateEventId(),
    eventName: event.name,
    emittedAt: event.emittedAt instanceof Date ? event.emittedAt.toISOString() : String(event.emittedAt),
    runId,
    sessionId: payload.sessionId as string | undefined,
    issueNumber: payload.issueNumber as number | undefined,
    payload,
  };
}

async function postEvent(
  url: string,
  body: NormalizedPayload,
  token: string | undefined,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Kody-Engine-Lite/1.0",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status} ${response.statusText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export const webhookHook: Hook = {
  async handle(
    event: KodyEvent,
    context: HookContext,
    config?: WebhookHookConfig,
  ): Promise<HookResult> {
    const url = getUrl(config);
    const token = getToken(config);

    if (!url) {
      // Silent skip — webhook not configured
      return { success: true, hookType: "webhook", data: { skipped: true } };
    }

    const runId = context.runId ?? "unknown";
    const body = buildPayload(event, runId);

    try {
      await postEvent(url, body, token);
      logger.debug(`[webhook] ${event.name} → ${url} [${runId}]`);
      return { success: true, hookType: "webhook", data: { url, eventName: event.name } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`[webhook] POST failed: ${message}`);
      return { success: false, hookType: "webhook", error: message };
    }
  },
};
