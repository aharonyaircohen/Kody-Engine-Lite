/**
 * Script catalog — maps profile-declared names to implementations.
 * Adding a new script: create src-v2/scripts/<name>.ts, export it, register
 * here. Any profile referencing an unregistered script name fails at load.
 */

import type { PreflightScript, PostflightScript } from "../executables/types.js"

import { runFlow } from "./runFlow.js"
import { fixFlow } from "./fixFlow.js"
import { fixCiFlow } from "./fixCiFlow.js"
import { resolveFlow } from "./resolveFlow.js"
import { loadConventions } from "./loadConventions.js"
import { loadCoverageRules } from "./loadCoverageRules.js"
import { composePrompt } from "./composePrompt.js"

import { parseAgentResult } from "./parseAgentResult.js"
import { verify } from "./verify.js"
import { checkCoverageWithRetry } from "./checkCoverageWithRetry.js"
import { commitAndPush } from "./commitAndPush.js"
import { ensurePr } from "./ensurePr.js"
import { postIssueComment } from "./postIssueComment.js"

export const preflightScripts: Record<string, PreflightScript> = {
  runFlow,
  fixFlow,
  fixCiFlow,
  resolveFlow,
  loadConventions,
  loadCoverageRules,
  composePrompt,
}

export const postflightScripts: Record<string, PostflightScript> = {
  parseAgentResult,
  verify,
  checkCoverageWithRetry,
  commitAndPush,
  ensurePr,
  postIssueComment,
}

export const allScriptNames: Set<string> = new Set([
  ...Object.keys(preflightScripts),
  ...Object.keys(postflightScripts),
])
