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
                   [--poll] [--poll-interval <ms>] [--poll-timeout <ms>]
```

| Flag | Description |
|------|-------------|
| `--session` | Session ID (required) |
| `--model` | Model to use (default: from `kody.config.json`) |
| `--cwd` | Working directory (default: current directory) |
| `--poll` | Enable polling mode for long-running sessions |
| `--poll-interval` | Milliseconds between polls (default: 5000) |
| `--poll-timeout` | Idle timeout in ms (default: 360000 = 6 min) |

## Polling Mode (`--poll`)

For long-running sessions, the chat command enters a polling loop that stays alive for up to 6 hours:

```bash
kody-engine chat --session <sessionId> --poll [--poll-interval 5000] [--poll-timeout 360000]
```

```
Dashboard → enqueues message via GitHub API (PUT action-state.json)
GitHub Actions → kody chat --poll
  every 5s: pollInstruction(runId, sessionId)
    if new instruction: process it → emit chat.message webhook → Dashboard
    if cancel: emit action.cancelled → emit chat.done → exit
    if no message for > idleTimeout: emit chat.done → exit
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--poll` | — | Enable polling mode (long-running) |
| `--poll-interval` | `5000` | Milliseconds between polls |
| `--poll-timeout` | `360000` | Idle timeout in ms (6 min). After this long with no message, session ends |

### Session Lifecycle

1. **Registration**: On startup, the session is registered in `.kody-engine/action-state.json` via `upsertChatSession(runId, sessionId)`.
2. **Polling**: Every `pollIntervalMs`, the queue is polled for new instructions.
3. **Message delivery**: When an instruction is found, `processMessage()` runs Claude Code and emits `chat.message` events.
4. **Idle exit**: If no message arrives for `idleTimeoutMs` (default 6 minutes), `chat.done` is emitted and the session ends.
5. **Cancellation**: If `cancel=true` appears in the action state, `action.cancelled` fires and the session ends immediately.

### Dashboard Integration

Dashboard enqueues a message by writing to the action-state file via GitHub Contents API:

```bash
# 1. Enqueue: push instruction onto the queue
gh api repos/{owner}/{repo}/contents/.kody-engine/action-state.json \
  --method PUT \
  --field message "Fix the auth bug" \
  --field encoding "base64"
# (Implementation: read → push to instructions[] → write back)

# 2. Webhook: engine POSTs to KODY_WEBHOOK_URL after each message
# Dashboard receives: { eventName, runId, sessionId, role, content, timestamp }
```

## Architecture Notes

### Stateless Workflows

GitHub Actions workflows are stateless — each run starts fresh. Session history is persisted to `.kody/sessions/<sessionId>.jsonl`, allowing Claude Code to resume the conversation across workflow runs.

### Event Delivery

Events are delivered via two paths:

1. **Event system** — chat events are emitted through Kody's internal event system, where they are logged and can trigger registered hooks (e.g. GitHub labels).
2. **Local file** — each event is also appended to `.kody/events/<sessionId>.jsonl`. External systems can poll this file for events.

### Concurrency

Each session has its own concurrency group (`chat-<sessionId>`). `cancel-in-progress: false` means new dispatches wait for the current run to complete rather than cancelling it — useful for queuing follow-up messages.

### Model Routing

Claude Code is invoked with `--output-format stream-json`, producing structured JSON output that the `chat` command parses to extract text deltas and tool call information. LiteLLM proxy is used when configured (`anyStageNeedsProxy()`), allowing the chat to route through any LiteLLM-supported provider.
