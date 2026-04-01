# docs: add troubleshooting guide for common pipeline issues

## Problem

LITELLM.md has a troubleshooting section, but there's no general troubleshooting page. When the pipeline fails, users need guidance on:

- How to read `status.json` to understand pipeline state
- How to inspect artifacts in `.kody/tasks/<task-id>/`
- Common failure modes and fixes (stuck pipeline, auth errors, timeout)
- What "infrastructure" vs "pre-existing" vs "abort" diagnosis means in practice
- How to debug when Kody posts a failure comment but the error is unclear

## Suggested approach

Create `docs/TROUBLESHOOTING.md` covering:

1. **Reading pipeline state** — `status.json` fields, stage states, how to find the failing stage
2. **Common errors** — model name rejected, proxy won't start, verify keeps failing, risk gate won't resume
3. **Diagnosis classifications explained** — what each of the 5 classifications means with real examples
4. **CI-specific issues** — permission errors, missing secrets, Actions timeout
5. **When to rerun vs start fresh** — guidance on `@kody rerun` vs `@kody` vs `@kody rerun --from <stage>`

Link from README docs section and FAQ.