/**
 * Shared preflight: load AGENTS.md / CLAUDE.md into context.
 */

import { loadProjectConventions } from "../prompt.js"
import type { PreflightScript } from "../executables/types.js"

export const loadConventions: PreflightScript = async (ctx) => {
  const conventions = loadProjectConventions(ctx.cwd)
  ctx.data.conventions = conventions
  if (conventions.length > 0) {
    process.stderr.write(`[kody2] loaded conventions: ${conventions.map((c) => c.path).join(", ")}\n`)
  }
}
