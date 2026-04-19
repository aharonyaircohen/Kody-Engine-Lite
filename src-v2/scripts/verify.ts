/**
 * Postflight: re-run quality commands as a trust-but-verify gate.
 */

import { verifyAll, summarizeFailure } from "../verify.js"
import type { PostflightScript } from "../executables/types.js"

export const verify: PostflightScript = async (ctx) => {
  try {
    const result = await verifyAll(ctx.config, ctx.cwd)
    ctx.data.verifyOk = result.ok
    ctx.data.verifyReason = result.ok ? "" : summarizeFailure(result)
  } catch (err) {
    ctx.data.verifyOk = false
    ctx.data.verifyReason = `verify crashed: ${err instanceof Error ? err.message : String(err)}`
  }
}
