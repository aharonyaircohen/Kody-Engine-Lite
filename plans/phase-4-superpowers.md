# Phase 4 — Superpowers Integration

## Goal
Add execution discipline to prompts via Superpowers methodology. No orchestration changes — only prompt content updates and memory system.

## Prerequisite
Phase 3 complete — 7-stage pipeline with persistence and resume works.

## What gets built

### New files

| File | ~Lines | Purpose |
|------|--------|---------|
| `src/memory.ts` | ~30 | Read `.kody/memory/*.md`, concatenate with headers |
| `.kody/memory/conventions.md` | ~15 | Seed template: Formatting, Testing, Imports, Patterns |
| `.kody/memory/architecture.md` | ~15 | Seed template: Overview, Key Modules, Data Flow |

### Modified files

| File | Change |
|------|--------|
| `prompts/taskify.md` | Add risk heuristics table, stricter output contract |
| `prompts/plan.md` | Add Superpowers "Writing Plans" methodology: TDD ordering, 2-5 min tasks, exact paths, verification steps |
| `prompts/build.md` | Add Superpowers "Executing Plans" methodology: follow exactly, verify each step, document deviations |
| `prompts/review.md` | Add severity definitions (Critical/Major/Minor), structured findings format |
| `prompts/review-fix.md` | Add "fix Critical+Major only" discipline, surgical edits, test verification |
| `prompts/autofix.md` | Add "try lintFix first" discipline, verify fixes by running commands |
| `src/context.ts` | Add `readProjectMemory()` call — prepend memory to prompt |
| `src/state-machine.ts` | Add post-pipeline auto-learn step (~40 lines) |

## Superpowers methodology (prompt-level, not runtime)

Superpowers is installed as a Claude Code plugin — it activates automatically. The prompts are updated to align with its methodology patterns:

### Prompt updates

**`prompts/taskify.md`** — Brainstorming pattern
- Add risk level heuristics:
  - Low: single file, no breaking changes, docs, config
  - Medium: multiple files, possible side effects, API changes
  - High: core logic, data migrations, security, auth
- Stricter JSON output contract (no markdown fences, no extra text)

**`prompts/plan.md`** — Writing Plans pattern
- Each step completable in 2-5 minutes
- Exact file paths (not "the test file")
- TDD ordering: test file before implementation
- Include verification step per task ("Run `pnpm test` to confirm")
- Ordered for incremental building (each step builds on previous)

**`prompts/build.md`** — Executing Plans pattern
- Follow plan EXACTLY — step by step, in order
- Read existing code before modifying (Use Read tool first)
- Verify each step after completion (Use Bash to run tests)
- Document any deviations from plan
- Do NOT commit — Kody handles git
- Complete code only — no stubs, no TODOs, no placeholders

**`prompts/review.md`** — Structured review
- Severity definitions:
  - Critical: security vulnerabilities, data loss, crashes, broken auth
  - Major: logic errors, missing edge cases, broken tests, perf issues
  - Minor: style, naming, readability, perf micro-optimization
- Structured output with Verdict header

**`prompts/review-fix.md`** — Surgical fixes
- Fix Critical and Major only (not Minor)
- Use Edit tool for surgical changes (not Write for full rewrites)
- Run tests after each fix
- If fix introduces new issues, revert

**`prompts/autofix.md`** — Systematic fix
- Try `pnpm lint:fix` and `pnpm format:fix` first (quick wins)
- Read error output carefully before making changes
- Run the failing command after each fix to verify

### YAML frontmatter (all prompts)
```markdown
---
name: <stage-name>
description: <what this agent does>
mode: primary
tools: [read, write, edit, bash, glob, grep]
---
```

## Memory system

### `src/memory.ts`
```typescript
function readProjectMemory(memoryDir: string): string
// - Read all *.md from .kody/memory/
// - Concat with "## <filename>" headers
// - Return empty string if dir doesn't exist (graceful)
```

### Context assembly update (`src/context.ts`)
```
1. memory = readProjectMemory(".kody/memory/")
2. prompt = readPromptFile("prompts/<stage>.md")
3. context = injectTaskContext(prompt, taskId, taskDir)
4. fullPrompt = memory + "\n---\n" + context
```

### Auto-learn (state-machine.ts, post-pipeline)
After successful pipeline completion:
- Read `review.md` for conventions mentioned
- Read `verify.md` for framework detections (e.g., "vitest" in output → "uses vitest")
- Append new learnings to `.kody/memory/conventions.md`
- Simple regex extraction, append-only, no dedup (Phase 1 of memory)

## What is NOT in Phase 4
- No LiteLLM (still using direct model names)
- No GitHub integration
- No git operations
- No CI/CD workflow
- No Brain/Engine split
- No memory dedup or relevance filtering

## Success criteria
```bash
# Prompts contain Superpowers methodology
grep -l "Superpowers\|TDD\|verification step" prompts/*.md  # All updated prompts

# Memory system works
echo "# Test convention" > .kody/memory/conventions.md
pnpm kody run --task-id 260325-mem-test --task "Add a helper function"
# Verify: memory content appears in prompt (check debug logs)

# Auto-learn creates entries
cat .kody/memory/conventions.md  # Should have new entries after successful run

# Plan quality improved (TDD ordering)
cat .kody/tasks/260325-mem-test/plan.md  # Steps should have test-first ordering

# Review quality improved (severity levels)
cat .kody/tasks/260325-mem-test/review.md  # Should have Critical/Major/Minor sections
```
