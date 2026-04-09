# Plan: Graph Memory Write + Commit Cycle

## Goal

Enable Kody to **write facts to the graph** during pipeline runs and **commit those changes to git**, so the graph persists across runs in GH Actions.

---

## Where to Write Facts

### 1. Review Stage — `src/stages/review.ts`

After generating a verdict, extract a fact and write it.

**Trigger:** When verdict is PASS or FAIL with meaningful feedback.

**What to write:**
- `hall`: `"conventions"` or `"facts"`
- `room`: inferred from scope (e.g. `"testing"`, `"auth"`)
- `content`: the key convention or decision from the review
- `episodeId`: created for this run

**Example:**
```
Input: "PASS — All tests pass. Note: project uses Vitest."
→ writeFact("conventions", "testing", "Uses Vitest for testing", episode.id)
```

**Edge cases:**
- Don't write if verdict has no useful content
- Deduplicate against existing current facts (same content → skip)
- Write once per review, not per file

### 2. Watch Pipeline — `src/watch/plugins/`

When a watch plugin detects a new issue (pipeline-health, config-health).

**Trigger:** Plugin finds something it hasn't seen before.

**What to write:**
- `hall`: `"events"` for failures, `"conventions"` for config changes
- `room`: plugin name (e.g. `"pipeline-health"`, `"config-health"`)
- `content`: the finding (e.g. "CI missing required env var")

**Example:**
```
Watch detects: "Pipeline Health: missing ANTHROPIC_API_KEY env var"
→ writeFact("events", "ci", "CI pipeline missing ANTHROPIC_API_KEY env var", episode.id)
```

---

## Pipeline Commit Step

### Where to Add It

The commit should happen **after the ship stage completes**, before the final status is posted.

**File:** `src/pipeline.ts` or `src/stages/ship.ts` — after `ship()` succeeds.

**Logic:**
```typescript
async function commitGraphChanges(projectDir: string): Promise<void> {
  const { getGraphDir } = await import("./memory/graph/index.js")
  const graphDir = getGraphDir(projectDir)

  // Check if graph has changes
  const status = await gitStatus(projectDir)  // git status .kody/graph/
  if (!status.includes(".kody/graph")) return  // no changes

  // git add .kody/graph/
  await gitAdd(projectDir, ".kody/graph/")

  // git commit -m "feat: update project memory graph"
  await gitCommit(projectDir, "Update project memory graph")
}
```

**When NOT to commit:**
- Dry run mode
- `git status .kody/graph/` returns nothing
- Pipeline failed (stages may have written partial data)

**Conflict handling:**
- If `git commit` fails due to conflict → warn but don't fail pipeline
- Log: `"⚠️ Graph commit conflict — another run updated memory"`

---

## File Changes

```
src/stages/review.ts         MODIFIED — call writeFact() after verdict
src/watch/plugins/           MODIFIED — call writeFact() on new findings
src/pipeline.ts              MODIFIED — commit graph after ship stage
src/memory/graph/
  └── write-utils.ts         NEW — deduplication, fact extraction helpers
```

---

## Execution Order

```
Step 1  →  Create write-utils.ts (dedup, extract helpers)
Step 2  →  Wire review.ts → writeFact()
Step 3  →  Wire watch plugins → writeFact()
Step 4  →  Add commit step to pipeline
Step 5  →  Test in kody-engine-tester
```

---

## Key Functions to Add

**`src/memory/graph/write-utils.ts`:**

```typescript
/** Check if a fact with identical content already exists (currently valid) */
export function factExists(projectDir: string, hall: HallType, room: string, content: string): boolean

/** Extract a likely room from file scope (e.g. ["src/auth/login.ts"] → "auth") */
export function inferRoomFromScope(scope: string[]): string

/** Write a fact only if it doesn't already exist (dedup) */
export function writeFactOnce(projectDir: string, hall: HallType, room: string, content: string, episodeId: string): GraphNode | null
```

---

## Out of Scope

- Complex LLM-based fact extraction (human-labeled only for now)
- Graph visualization
- Edge writing in watch plugins
- Retry logic for git conflicts (warn and continue)
