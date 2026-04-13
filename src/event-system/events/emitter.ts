/**
 * @fileOverview Event System — Event Emitter
 * @fileType event-system
 */

import type { KodyEvent, EventName, EventPayloadMap } from "./types.js";
import { isEventName } from "./types.js";
import type { HookContext } from "../hooks/types.js";
import { HookRegistry } from "../hooks/registry.js";
import { logEvent } from "../store/event-log.js";
import { logger } from "../../logger.js";

type EventHandler<N extends EventName = EventName> = (
  event: KodyEvent<N>,
) => void | Promise<void>;

export class KodyEmitter {
  private handlers = new Map<string, Set<EventHandler>>();
  private globalHandlers = new Set<EventHandler>();
  private registry: HookRegistry;

  constructor() {
    this.registry = new HookRegistry();
  }

  on<N extends EventName>(event: N, handler: EventHandler<N>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.handlers.get(event)?.delete(handler as EventHandler);
  }

  once<N extends EventName>(event: N, handler: EventHandler<N>): () => void {
    const wrapped = (evt: KodyEvent) => {
      handler(evt as KodyEvent<N>);
      this.off(event, wrapped);
    };
    return this.on(event, wrapped as EventHandler<N>);
  }

  off<N extends EventName>(event: N, handler: EventHandler<N>): void {
    this.handlers.get(event)?.delete(handler as EventHandler);
  }

  onAny(handler: EventHandler): () => void {
    this.globalHandlers.add(handler);
    return () => this.globalHandlers.delete(handler);
  }

  /**
   * Emit an event — fires all registered handlers and hook registry.
   */
  async emit<N extends EventName>(
    name: N,
    payload: EventPayloadMap[N],
  ): Promise<KodyEvent<N>> {
    if (!isEventName(name)) {
      logger.warn(`[event] Unknown event name: ${name}`);
      throw new Error(`Unknown event name: ${name}`);
    }

    const event: KodyEvent<N> = {
      name,
      payload,
      emittedAt: new Date(),
    };

    logger.debug(`[event] ${event.name} | ${JSON.stringify(event.payload)}`);

    // 1. Fire in-process handlers
    const handlers = this.handlers.get(event.name);
    if (handlers) {
      await Promise.allSettled([...handlers].map((h) => h(event)));
    }
    await Promise.allSettled([...this.globalHandlers].map((h) => h(event)));

    // 2. Extract runId from payload for logging
    const runId = (event.payload as { runId?: string }).runId ?? "unknown";

    // 3. Log the event
    logEvent(
      runId,
      event.name,
      event.payload as unknown as Record<string, unknown>,
      [],
      {},
    );

    // 4. Fire hook registry (GitHub labels, PRs, etc.)
    const context: HookContext = {
      runId,
      sessionId: (event.payload as { sessionId?: string }).sessionId,
      issueNumber: (event.payload as { issueNumber?: number }).issueNumber,
    };
    try {
      const hookResults = await this.registry.fire(event, context);
      for (const result of hookResults) {
        if (!result.success) {
          logger.debug(`[hook] ${result.hookType} failed: ${result.error}`);
        }
      }
    } catch (err) {
      logger.debug(`[hook-registry] fire error: ${err}`);
    }

    return event;
  }

  removeAllListeners(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }
}

// Singleton instance
export const emitter = new KodyEmitter();

/**
 * Convenience emit — call from anywhere in the engine.
 *
 * @example
 * emit("step.waiting", { runId: "123", step: "build" })
 */
export function emit<N extends EventName>(
  name: N,
  payload: EventPayloadMap[N],
): Promise<KodyEvent<N>> {
  return emitter.emit(name, payload);
}

export type { KodyEvent, EventName };
