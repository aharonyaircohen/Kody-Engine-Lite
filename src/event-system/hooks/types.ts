/**
 * @fileOverview Event System — Hook Types
 * @fileType type-definitions
 */

import type { KodyEvent, EventName } from "../events/types.js";

// ============ Hook Config Types ============

export type HookType =
  | "github-action"
  | "github-label"
  | "github-pr"
  | "github-pr-merge"
  | "log";

export interface GitHubLabelHookConfig {
  type: "github-label";
  labels?: string[];
  remove?: string[];
}

export interface GitHubActionHookConfig {
  type: "github-action";
  pollInterval?: number;
  timeout?: number;
}

export interface GitHubPrHookConfig {
  type: "github-pr";
  branch?: string;
  create?: boolean;
}

export interface GitHubPrMergeHookConfig {
  type: "github-pr-merge";
  autoMerge?: boolean;
  mergeMethod?: "merge" | "squash" | "rebase";
}

export interface LogHookConfig {
  type: "log";
  level?: "debug" | "info" | "warn" | "error";
}

export type HookConfig =
  | GitHubLabelHookConfig
  | GitHubActionHookConfig
  | GitHubPrHookConfig
  | GitHubPrMergeHookConfig
  | LogHookConfig;

// ============ Hook Implementation ============

export interface HookContext {
  runId: string;
  sessionId?: string;
  taskId?: string;
  issueNumber?: number;
  githubOwner?: string;
  githubRepo?: string;
}

export interface HookResult {
  success: boolean;
  hookType: HookType;
  error?: string;
  data?: unknown;
}

export interface Hook {
  handle(event: KodyEvent, context: HookContext): Promise<HookResult> | HookResult;
}

// ============ Registry Types ============

export type HookConfigMap = Partial<Record<EventName, HookConfig[]>>;
