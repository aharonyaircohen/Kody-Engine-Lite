# Plan: Flat-File Graph Memory for Kody Engine

## Goal

Replace Kody's flat `.md` file memory system with a structured flat-file JSON graph that supports:
- **Temporal facts** — validFrom/validTo on every fact
- **Provenance** — every fact traces to an episode (run, review, user feedback)
- **Relationships** — edges between facts (supersedes, applies_to, caused_by)
- **Hall-aware queries** — filter by hall (facts, conventions, events, preferences, thoughts)
- **Zero deps** — pure TypeScript + `fs`, no native compilation

---

## Directory Structure

```
src/memory/
├── graph/
│   ├── types.ts         # Node, Edge, Episode interfaces
│   ├── store.ts         # read/write JSON files (with lock)
│   ├── episode.ts       # Episode management
│   ├── queries.ts       # getCurrentFacts, getFactHistory, etc.
│   └── index.ts         # Public API exports

.kody/graph/             # Per-project graph store (committed to git)
├── nodes.json           # track in git
├── edges.json           # track in git
└── episodes/            # track in git (user-labeled)
    ├── run_001.json     # gitignore pattern: episodes/run_*.json
    └── user_feedback_001.json
```

**`.gitignore` update:**
```
.kody/graph/episodes/run_*.json
```

Rationale: `nodes.json` and `edges.json` ARE the project knowledge — they travel with the repo so the team benefits. Episodes are provenance (noisy, run-specific) — gitignore `run_*.json`. User feedback episodes are valuable — track those.

---

## Phase 1 — Core Infrastructure (TDD)

### 1.1 Types

**`src/memory/graph/types.ts`**

```typescript
export type HallType = "facts" | "conventions" | "events" | "preferences" | "thoughts"

export type NodeType = HallType | "derived" | "source"

export type RelationshipType =
  | "superseded_by"
  | "supersedes"
  | "applies_to"
  | "related_to"
  | "caused_by"
  | "derived_from"

export interface GraphNode {
  id: string              // e.g. "facts_auth_jwt_1746772800"
  type: NodeType
  hall: HallType
  room: string            // e.g. "auth", "testing", "ci"
  content: string
  episodeId: string        // provenance
  validFrom: string       // ISO 8601
  validTo: string | null  // null = currently true
  tags?: string[]
}

export interface GraphEdge {
  id: string
  from: string            // source node id
  rel: RelationshipType
  to: string              // target node id
  episodeId: string
  validFrom: string
  validTo: string | null
}

export interface Episode {
  id: string              // "ep_run_042" or "ep_usr_001"
  runId: string
  source: "plan" | "review" | "user_feedback" | "ci_failure" | "decompose" | "migration"
  taskId: string
  createdAt: string
  rawContent: string
  extractedNodeIds: string[]
  linkedFiles?: string[]
  metadata?: Record<string, unknown>
}
```

**ID format:**
- Node: `{hall}_{room}_{timestamp}` — e.g. `facts_auth_1746772800`
- Edge: `{from}_{rel}_{to}` — e.g. `facts_auth_jwt_superseded_by_facts_auth_jwt_1746772800`
- Episode: `ep_{source}_{seq}` — e.g. `ep_review_001`, `ep_usr_feedback_042`

### 1.2 Store (with concurrency-safe writes)

**`src/memory/graph/store.ts`**

Files must handle concurrent writes (watch pipeline + manual CLI can write simultaneously).

**Lock strategy:** Use `fs.rename()` atomic swap — it's atomic on POSIX systems (Linux, macOS). On Windows fallback, use a `.lock` sentinel file.

```typescript
// Pattern for every write:
// 1. Write to temp file  (temp.json)
// 2. fs.rename(temp.json, actual.json)  ← atomic on POSIX

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

const GRAPH_DIR = ".kody/graph"
const NODES_FILE = "nodes.json"
const EDGES_FILE = "edges.json"

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8")
  fs.renameSync(tmp, filePath)  // atomic on POSIX
}

// Public API:
export function readNodes(projectDir: string): Record<string, GraphNode>
export function writeNodes(projectDir: string, nodes: Record<string, GraphNode>): void
export function readEdges(projectDir: string): GraphEdge[]
export function writeEdges(projectDir: string, edges: GraphEdge[]): void
export function ensureGraphDir(projectDir: string): void
export function getGraphDir(projectDir: string): string
```

### 1.3 Episode Management

**`src/memory/graph/episode.ts`**

```typescript
export function createEpisode(projectDir: string, data: Omit<Episode, "id">): Episode
export function getEpisode(projectDir: string, episodeId: string): Episode | null
export function getNextEpisodeSeq(projectDir: string, source: Episode["source"]): number
```

---

## Phase 2 — Query Layer (TDD)

### 2.1 Node Queries

**`src/memory/graph/queries.ts`**

```typescript
// Node queries
export function getCurrentFacts(projectDir: string, hall?: HallType, room?: string): GraphNode[]
export function getFactsAtTime(projectDir: string, isoTime: string, hall?: HallType): GraphNode[]
export function getFactHistory(projectDir: string, nodeId: string): GraphNode[]
export function getFactById(projectDir: string, nodeId: string): GraphNode | null
export function searchFacts(projectDir: string, query: string, hall?: HallType, limit?: number): GraphNode[]

// Edge queries
export function getOutgoingEdges(projectDir: string, nodeId: string, rel?: RelationshipType): GraphEdge[]
export function getIncomingEdges(projectDir: string, nodeId: string, rel?: RelationshipType): GraphEdge[]
export function getRelatedFacts(projectDir: string, nodeId: string, rel?: RelationshipType, hall?: HallType): GraphNode[]

// Episode queries
export function getEpisodesByRun(projectDir: string, runId: string): Episode[]
export function getEpisodesBySource(projectDir: string, source: Episode["source"]): Episode[]
export function getFactProvenance(projectDir: string, nodeId: string): Episode | null
```

---

## Phase 3 — Write Operations (TDD)

### 3.1 Node Writes

```typescript
export function writeFact(
  projectDir: string,
  hall: HallType,
  room: string,
  content: string,
  episodeId: string,
): GraphNode

export function updateFact(
  projectDir: string,
  existingNodeId: string,
  newContent: string,
  episodeId: string,
): GraphNode
// - Finds existing node by id
// - Sets validTo = now on existing node
// - Creates new node with new content, same hall+room, new timestamp in id
// - Writes superseded_by edge from old → new

export function invalidateFact(projectDir: string, nodeId: string): void
// - Sets validTo = now (soft delete)
```

### 3.2 Edge Writes

```typescript
export function writeEdge(
  projectDir: string,
  from: string,
  rel: RelationshipType,
  to: string,
  episodeId: string,
): GraphEdge

export function invalidateEdge(projectDir: string, edgeId: string): void
```

### 3.3 High-Level

```typescript
export function extractFactFromEpisode(
  projectDir: string,
  hall: HallType,
  room: string,
  content: string,
  episode: Episode,
): GraphNode
// - Calls createEpisode() if episode not yet created
// - Calls writeFact()
// - Links node to episode
```

---

## Phase 4 — Markdown Serialization (TDD)

**`src/memory/graph/serialize.ts`** — converts graph nodes back to markdown for prompt injection

```typescript
export function graphNodesToMarkdown(
  nodes: GraphNode[],
  options?: {
    includeHall?: boolean
    maxLength?: number
  }
): string
```

**Output format** — must match existing `.md` format for backward compat with existing stages:

```markdown
## facts

### auth
- User prefers session cookies over JWT for browser auth (added 2026-03-15)

### testing
- Vitest is preferred over Jest — faster, native ESM support (added 2026-03-15)

## conventions

### typescript
- Use `satisfies` operator for type narrowing (added 2026-02-20)
```

This mirrors the existing `readProjectMemory()` output exactly — stages don't need to change.

---

## Phase 5 — Migration (TDD)

**`src/memory/migration.ts`**

### 5.1 Project Memory Migration

```typescript
export function migrateProjectMemory(projectDir: string): {
  migrated: number
  skipped: number
  errors: string[]
}
```

- Reads `.kody/memory/*.md`
- Parses hall + room from filename (`conventions_auth.md` → hall: "conventions", room: "auth")
- Parses multiple entries per file (splits on `- ` bullet points)
- Creates episode per file (source: "migration")
- Calls `writeFact()` for each entry
- Does NOT delete old files

### 5.2 Run History Migration

```typescript
export function migrateRunHistory(projectDir: string): {
  migrated: number
  errors: string[]
}
```

- Reads `.kody/run-history.json`
- Converts each run record → Episode

### 5.3 Brain Migration

```typescript
export function migrateBrain(projectDir: string): {
  migrated: number
  errors: string[]
}
```

- Reads `~/.kody/brain/memory/*.md`
- Migrates to project graph with hall prefix

---

## Phase 6 — CLI Commands

**`src/bin/commands/graph.ts`**

```bash
kody graph status <projectDir>   # nodes, edges, episodes count + disk size
kody graph migrate <projectDir>   # run all migrations
kody graph query <query>          # search facts
kody graph show <nodeId>          # show fact + provenance + history
kody graph clear                  # reset (requires --confirm)
```

---

## Phase 7 — Integration (TDD)

### 7.1 Replace `readProjectMemory()`

**`src/memory.ts`**

```typescript
import * as graph from "./memory/graph/index.js"
import { graphNodesToMarkdown } from "./memory/graph/serialize.js"

export function readProjectMemory(projectDir: string): string {
  const nodes = graph.getCurrentFacts(projectDir)

  if (nodes.length > 0) {
    return graphNodesToMarkdown(nodes)
  }

  // Fallback: legacy .md files
  return readProjectMemoryLegacy(projectDir)
}
```

### 7.2 Replace `readProjectMemoryTiered()`

**`src/context-tiers.ts`**

```typescript
export function readProjectMemoryTiered(
  projectDir: string,
  tier: ContextTier,
  hallFilter?: HallType[],
  roomFilter?: string[] | null,
): string {
  const nodes = graph.getCurrentFacts(projectDir, hallFilter?.[0], roomFilter?.[0])

  if (nodes.length === 0) {
    // Fallback: legacy .md files
    return readProjectMemoryTieredLegacy(projectDir, tier, hallFilter, roomFilter)
  }

  // Apply room filter manually
  const filtered = roomFilter
    ? nodes.filter(n => roomFilter.includes(n.room))
    : nodes

  // Apply tier summarization
  return graphNodesToMarkdown(filtered, { maxLength: tierLength(tier) })
}
```

### 7.3 Update `readBrainMemory()`

**`src/memory.ts`**

```typescript
export function readBrainMemory(): string {
  // Still reads from ~/.kody/brain/ for now
  // Brain stays file-based (user personal context)
  // Future: could also merge graph nodes with brain
}
```

### 7.4 Review Stage Integration

In `src/stages/review.ts`:
- After generating verdict, call `createEpisode()` with source: "review"
- Extract facts from feedback → `extractFactFromEpisode()`
- If prior fact exists with different content → `updateFact()`

### 7.5 Watch Pipeline Integration

In watch pipeline stages:
- New findings → `createEpisode()` + `extractFactFromEpisode()`
- Link to which watch run created it

---

## Phase 8 — `.gitignore` Update

**`.gitignore`** — add:
```
# Graph memory (tracked — project knowledge)
# !.kody/graph/nodes.json
# !.kody/graph/edges.json
# !.kody/graph/episodes/*.json

# Graph episodes (run-specific, noisy — gitignore)
.kody/graph/episodes/run_*.json
```

Wait — negation patterns in gitignore are fragile. Better approach:

**Don't gitignore the folder at all.** Instead:
- `nodes.json` and `edges.json` committed
- `episodes/run_*.json` gitignored via pattern

```gitignore
# Graph memory — track nodes + edges, gitignore run episodes
.kody/graph/
!.kody/graph/nodes.json
!.kody/graph/edges.json
!.kody/graph/episodes/
.kody/graph/episodes/run_*.json
```

This says: track the whole folder EXCEPT `run_*.json` episodes.

---

## Execution Order

```
Phase 1  →  Types + Store + Episode management  [TDD]
Phase 2  →  Query layer                        [TDD]
Phase 3  →  Write operations                   [TDD]
Phase 4  →  Markdown serialization             [TDD]
Phase 5  →  Migration                          [TDD]
Phase 6  →  CLI commands
Phase 7  →  Integration (memory.ts, context-tiers, review, watch)
Phase 8  →  .gitignore update + commit migration
```

---

## File Inventory

```
src/memory/graph/
├── types.ts        # NEW
├── store.ts        # NEW  (with atomic writes)
├── episode.ts      # NEW
├── queries.ts      # NEW
├── serialize.ts    # NEW  (graphNodesToMarkdown)
└── index.ts        # NEW

src/memory/
├── migration.ts    # NEW

src/memory.ts         # MODIFIED — read from graph, fallback to .md
src/context-tiers.ts   # MODIFIED — use graph store
src/cli.ts             # MODIFIED — add `kody graph` CLI
src/stages/review.ts   # MODIFIED — extract facts to graph
src/watch/**/*.ts      # MODIFIED — write findings to graph

tests/unit/
└── memory-graph.test.ts   # NEW

.gitignore             # MODIFIED — graph episodes pattern
```

---

## Out of Scope (v1)

- Graph visualization
- LLM-based auto-extraction of entities (human-labeled only)
- Multi-user / sync
- Import/export
- Binary episodes (screenshots, logs)
- Graph algorithms (PageRank, centrality — unnecessary at this scale)

---

## Design Decisions Resolved

| Decision | Choice | Reason |
|---|---|---|
| Concurrency | `fs.rename()` atomic swap | POSIX atomic, no extra deps |
| Git tracking | Track `nodes.json`, `edges.json`, user episodes | Project knowledge travels with repo |
| `.gitignore` | Only `episodes/run_*.json` ignored | Run-specific noise excluded |
| Node IDs | `{hall}_{room}_{timestamp}` | Unique, readable, sortable |
| Markdown format | Matches existing `.md` output | Zero change to stages |
| Brain memory | Stays in `~/.kody/brain/` | User personal context, not project |
| Migration | Non-destructive | `.md` files remain readable |
| Tests | Written before each phase | TDD approach |
