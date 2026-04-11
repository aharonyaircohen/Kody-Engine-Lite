# Chat Sessions

Kody's engine-centric chat system uses GitHub Actions workflows to run AI conversations, persisted as JSONL files and driven entirely by Kody's event system.

## Overview

```
Dashboard → triggers chat.yml workflow_dispatch
GitHub Actions → kody chat --session <sessionId>
  → reads .kody/sessions/<sessionId>.jsonl
  → runs Claude Code
  → emits chat.message events
  → appends to .kody/sessions/<sessionId>.jsonl
  → emits chat.done / chat.error
```

## Session File Format

Sessions are stored as newline-delimited JSON (JSONL) at `.kody/sessions/<sessionId>.jsonl`.

Each line is a message object:

```json
{"role":"user","content":"What should I refactor first?","timestamp":"2026-04-11T10:00:00.000Z","toolCalls":[]}
{"role":"assistant","content":"I'd start with the authentication module.","timestamp":"2026-04-11T10:00:05.000Z","toolCalls":[]}
{"role":"assistant","content":"Running tests on auth module...","timestamp":"2026-04-11T10:00:10.000Z","toolCalls":[{"name":"Bash","arguments":{"command":"npm test -- auth"},"result":"5 passed, 0 failed","status":"completed"}]}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `role` | `"user"` \| `"assistant"` | Message author |
| `content` | `string` | Message text content |
| `timestamp` | `string` | ISO 8601 timestamp |
| `toolCalls` | `ToolCall[]` | Tool invocations made during this message (assistant only) |

### ToolCall Shape

```typescript
interface ToolCall {
  name: string       // Tool name (e.g. "Bash", "Read", "Edit")
  arguments: unknown  // Arguments passed to the tool
  result?: unknown   // Return value / output
  status: "completed" | "failed" | "in_progress"
}
```

## Session ID

**`sessionId = taskId`**. Each task maps to exactly one chat session. The session file name is the task's ID. This means:

- All chat history for a task is in one file
- Reopening a task restores full conversation context
- The same session can be resumed across multiple workflow runs

## Events

The chat system emits three events through Kody's event system:

### `chat.message`

Emitted once per message (user or assistant) produced during the session.

```typescript
interface ChatMessagePayload {
  runId: string
  sessionId: string      // = taskId
  role: "user" | "assistant"
  content: string
  timestamp: string       // ISO 8601
  toolCalls?: ToolCall[] // assistant messages only
}
```

### `chat.done`

Emitted when the session completes successfully.

```typescript
interface ChatDonePayload {
  runId: string
  sessionId: string
}
```

### `chat.error`

Emitted when the session fails.

```typescript
interface ChatErrorPayload {
  runId: string
  sessionId: string
  error: string
}
```

## Triggering a Chat Session

A chat session is triggered by calling the GitHub Actions `workflow_dispatch` API on the `chat.yml` workflow:

```bash
# 1. Write the user message to the session file
echo '{"role":"user","content":"<message>","timestamp":"<iso>","toolCalls":[]}' \
  >> .kody/sessions/<sessionId>.jsonl

# 2. Trigger the workflow
gh api repos/{owner}/{repo}/actions/workflows/chat.yml/dispatches \
  -f ref=main \
  -f inputs.sessionId=<sessionId>
```

The workflow reads the full session file, runs Claude Code with the conversation context, and emits events.

## CLI Command

```bash
kody-engine chat --session <sessionId> [--model <model>] [--cwd <dir>]
```

| Flag | Description |
|------|-------------|
| `--session` | Session ID (required) |
| `--model` | Model to use (default: from `kody.config.json`) |
| `--cwd` | Working directory (default: current directory) |

## Architecture Notes

### Stateless Workflows

GitHub Actions workflows are stateless — each run starts fresh. Session history is persisted to `.kody/sessions/<sessionId>.jsonl`, allowing Claude Code to resume the conversation across workflow runs.

### Event Delivery

Events are delivered via two paths:

1. **HTTP POST** — The `dashboardHook` fires on each event, POSTing directly to the dashboard's `/api/kody/events` endpoint. This is the primary path for real-time delivery.
2. **Local file** — Each event is also appended to `.kody/events/<sessionId>.jsonl` in the workflow run directory. This serves as a backup poll source for the SSE endpoint.

### Concurrency

Each session has its own concurrency group (`chat-<sessionId>`). `cancel-in-progress: false` means new dispatches wait for the current run to complete rather than cancelling it — useful for queuing follow-up messages.

### Model Routing

Claude Code is invoked with `--output-format stream-json`, producing structured JSON output that the `chat` command parses to extract text deltas and tool call information. LiteLLM proxy is used when configured (`anyStageNeedsProxy()`), allowing the chat to route through any LiteLLM-supported provider.
