/**
 * Shared preflight: expose the kody.config.json testRequirements in context.
 * The composePrompt and checkCoverageWithRetry scripts consume ctx.data.coverageRules.
 */

import type { PreflightScript } from "../executables/types.js"

export const loadCoverageRules: PreflightScript = async (ctx) => {
  ctx.data.coverageRules = ctx.config.testRequirements ?? []
}
