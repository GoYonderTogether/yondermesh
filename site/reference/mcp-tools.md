---
title: MCP Tools
description: Canonical reference for every tool exposed by the yondermesh MCP server (ymesh mcp) — arguments, return shapes, and CLI invocation examples.
outline: [2, 3]
---

# MCP Tools

The `ymesh mcp` command starts a stdio JSON-RPC server that exposes yondermesh's session graph to any MCP-capable agent (Claude Code, Codex, Cursor, Gemini, Windsurf, Continue, ...). Once registered, agents can call these tools to query recent work, inspect what's happening on this device, hand off tasks, and exchange messages across sessions.

This page is the canonical tool list, grounded in `src/mcp/server.ts`. Tools are listed in the order they are registered.

## How to call

### From the CLI

```bash
ymesh mcp call <tool> [args]
```

Arguments are passed as `key=value` pairs. Example:

```bash
ymesh mcp call who_is_working
ymesh mcp call search_sessions agent=claude since=7d limit=10
ymesh mcp call get_session_detail session_id=019f5fe4-b127-7de2-b8f1-efa45bee24cb live=true
```

### From an MCP-capable agent

Register the server in the agent's MCP config:

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "ymesh",
      "args": ["mcp"]
    }
  }
}
```

The agent then issues JSON-RPC `tools/call` requests with `name` and `arguments`. yondermesh responds with `{ content: [{ type: "text", text: <json-or-text> }], isError: false }`.

### Common conventions

- **Session IDs** are the native IDs from each CLI (e.g. Claude Code's UUIDv7, Codex's rollout filename stem).
- **Relative time** strings (`since`, `from`, `to`) accept ISO 8601 timestamps or `<n><unit>` shorthand where unit is `d` / `h` / `m` (e.g. `7d`, `24h`, `30m`).
- **Topology** is `root` (a real user-initiated session) or `subagent` (a session spawned by another agent). Queries that don't ask for subagents return roots only by default.
- All JSON returned by tools is a single-line `JSON.stringify` output; the examples below are pretty-printed for readability.

## search_sessions

Search session records across every agent on this device. Use this before starting a new task to find related historical work.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | no | Exact project path match |
| `project_prefix` | string | no | Project path prefix match (directory-boundary safe) |
| `agent` | string | no | Filter by canonical source: `claude`, `codex`, `opencode`, `hermes`, `kimi`, `cursor`, `copilot`, `gemini` |
| `topology` | string | no | `root` or `subagent` |
| `since` | string | no | ISO 8601 or relative (`7d` / `24h` / `30m`) |
| `limit` | number | no | Return count, default 20, clamped to 1-200 |

### Returns

JSON array of session summary objects:

```json
[
  {
    "id": "019f5fe4-b127-7de2-b8f1-efa45bee24cb",
    "source": "claude",
    "projectPath": "/Users/zoran/projects/yondermesh",
    "cwd": "/Users/zoran/projects/yondermesh",
    "topology": "root",
    "messageCount": 42,
    "startedAt": 1719500000000,
    "lastSeenAt": 1719503600000,
    "model": "claude-sonnet-4",
    "cliVersion": "1.0.0",
    "originator": "cli",
    "threadSource": "claude-code"
  }
]
```

### Example

```bash
ymesh mcp call search_sessions project_prefix=/Users/zoran/projects since=7d limit=5
```

## get_session_detail

Return the message stream for one session. Supports a `live` mode that re-reads the source file (so still-running sessions return their latest messages), plus handoff-oriented options for task takeover.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session ID |
| `live` | boolean | no | `true` = read source file directly (recommended for running sessions) |
| `limit` | number | no | Return only the last N messages |
| `include_compacted` | boolean | no | In live mode, also return `compacted_summaries` (codex compressed summaries). Default `false` |
| `include_tool_calls` | boolean | no | In live mode, preserve `function_call` / `function_call_output` blocks (truncated). Default `false` |
| `handoff_mode` | boolean | no | `true` = shorthand for `live=true + include_compacted=true + include_tool_calls=true + limit=30`. Default `false` |

### Returns

Default (DB or plain live mode): JSON array of messages:

```json
[
  { "seq": 0, "role": "user", "content": "..." },
  { "seq": 1, "role": "assistant", "content": "...", "timestamp": 1719500001000 }
]
```

Rich context mode (`include_compacted` / `handoff_mode`): JSON object:

```json
{
  "messages": [ /* recent messages, tool calls preserved */ ],
  "compacted_summaries": [ /* codex compacted history */ ]
}
```

### Example

```bash
ymesh mcp call get_session_detail session_id=019f5fe4-... live=true handoff_mode=true
```

## get_session_handoff

Purpose-built for task takeover. Reads the source file directly and returns a compacted handoff package: codex-compressed summaries, the last real user message, a tail of recent messages (with `function_call` / `function_call_output` / `custom_tool_call` preserved and truncated), the task plan, session metadata, and live status. Use this when one agent needs to pick up where another left off without losing tool-call detail.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session ID |
| `tail_messages` | number | no | Number of tail messages (with tool calls) to include. Default `30` |

### Returns

JSON `HandoffPackage` object (see `src/mcp/codex-handoff.ts` for the full shape):

```json
{
  "session_id": "...",
  "compacted_summaries": [ "..." ],
  "last_user_message": "...",
  "recent_messages": [ /* tail with tool calls preserved */ ],
  "task_plan": [ /* update_plan items, if present */ ],
  "session": { /* session metadata */ },
  "is_live": true
}
```

### Example

```bash
ymesh mcp call get_session_handoff session_id=019f5fe4-... tail_messages=50
```

## get_session_relations

Return the relationship topology for one session: parents, children, and related sessions.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session ID |

### Returns

JSON array of relations:

```json
[
  { "type": "spawned", "direction": "outgoing", "sessionId": "child-uuid" },
  { "type": "forked", "direction": "incoming", "sessionId": "parent-uuid" }
]
```

`direction` is `outgoing` (this session spawned the related one) or `incoming` (the related session spawned this one).

### Example

```bash
ymesh mcp call get_session_relations session_id=019f5fe4-...
```

## get_overview

Return aggregate statistics for all sessions on this device. Useful for daily digests or quick health checks.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `since` | string | no | Only count sessions started after this time (ISO 8601 or relative) |
| `project_prefix` | string | no | Only count sessions whose project matches this prefix |

### Returns

JSON `SessionStats` object (shape defined by `src/store/types.ts`): typically total counts, breakdown by source, breakdown by topology, and time-bucketed activity.

### Example

```bash
ymesh mcp call get_overview since=24h
```

## list_active_sessions

List sessions currently running or recently active, with a runtime summary. Queries the DB directly; reflects the most recent scan cycle.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `within_minutes` | number | no | Look back window in minutes. Default `30` |

### Returns

JSON `ActiveSessionsSummary` object:

```json
{
  "totalActive": 3,
  "liveCount": 2,
  "subagentActive": 1,
  "bySource": { "claude": 2, "codex": 1 },
  "sessions": [
    {
      "sessionId": "019f5fe4-...",
      "source": "claude",
      "cwd": "/Users/zoran/projects/yondermesh",
      "topology": "root",
      "isLive": true,
      "lastSeenAt": 1719503600000
    }
  ]
}
```

### Example

```bash
ymesh mcp call list_active_sessions within_minutes=10
```

## who_is_working

Quick human-readable summary of which agents are currently working on this machine. Returns plain text, not JSON — designed for an agent to glance at the device's current activity before starting a task.

### Arguments

None.

### Returns

Plain text. Example:

```text
本机当前有 3 个 session 活跃中（2 个 live，1 个 subagent）：

[live] 019f5fe4-b...  claude        ~/projects/yondermesh  最近 12 秒前
[live] 019f6a21-c...  codex         ~/projects/myapp      最近 3 分钟前
[    ] sub:019f6b40-  claude        ~/projects/yondermesh  最近 8 分钟前

按 source 分布: claude=2, codex=1
```

### Example

```bash
ymesh mcp call who_is_working
```

## post_message

Send a message to another agent session or broadcast to a project. Used for cross-session communication — for example, notifying another agent that a task is done, raising a question, or proposing a handoff. Messages are stored in local SQLite; recipients read them via `get_messages`.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `body` | string | yes | Message content |
| `to_session_id` | string | no | Direct message — target session ID |
| `to_project` | string | no | Broadcast — target project path (all agents on that project receive it) |
| `from_session_id` | string | no | Sender session ID |
| `kind` | string | no | One of `info`, `warning`, `question`, `task_update`. Default `info` |

One of `to_session_id` or `to_project` should be set; if neither is set the message is stored with no recipient.

### Returns

```json
{ "messageId": 42, "posted": true }
```

### Example

```bash
ymesh mcp call post_message to_session_id=019f6a21-c... body="Tests pass, ready to merge" kind=task_update
```

## get_messages

Read messages addressed to a session or project. Messages are auto-marked as read on retrieval.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `for_session_id` | string | no | Direct messages for this session |
| `for_project` | string | no | Broadcast messages for this project |
| `since_minutes` | number | no | Look back window in minutes. Default `60` |
| `unread_only` | boolean | no | Only return unread messages. Default `false` |

### Returns

JSON array of messages (shape from `src/store/`):

```json
[
  {
    "id": 42,
    "toSessionId": "019f6a21-...",
    "fromSessionId": "019f5fe4-...",
    "body": "Tests pass, ready to merge",
    "kind": "task_update",
    "createdAt": 1719503600000,
    "read": false
  }
]
```

### Example

```bash
ymesh mcp call get_messages for_session_id=019f6a21-... unread_only=true
```

## extract_project_history

Extract every user requirement (user message) and agent response (assistant message) from all sessions under a project into indexable NDJSONL files. This is the first step for understanding what a user has actually asked for on a project over time. If `force_refresh=false` and a previous extract exists, returns the existing stats without re-extracting.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | yes | Project path (cwd prefix match) |
| `force_refresh` | boolean | no | `true` = re-extract from scratch. Default `false` |

### Returns

```json
{
  "projectHash": "a1b2c3...",
  "projectPath": "/Users/zoran/projects/yondermesh",
  "requirementCount": 128,
  "responseCount": 412,
  "sessionCount": 14,
  "extractedAt": 1719503600000,
  "extractsDir": "~/.yondermesh/extracts/a1b2c3...",
  "refreshed": true
}
```

### Example

```bash
ymesh mcp call extract_project_history project_path=/Users/zoran/projects/yondermesh force_refresh=true
```

## query_user_requirements

Query the extracted user requirements (user messages) for a project. Filter by keyword, session, time range, or exact line ID. Requires `extract_project_history` to have been run first.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | yes | Project path (must match the path used for `extract_project_history`) |
| `keyword` | string | no | Case-insensitive substring match on content |
| `session_id` | string | no | Filter by session ID |
| `from` | string | no | Start time (ISO 8601 or relative) |
| `to` | string | no | End time (ISO 8601 or relative) |
| `id` | number | no | Exact line ID (1-based). When set, all other filters are ignored |
| `limit` | number | no | Return cap. Default `20`, clamped to 1-500 |
| `offset` | number | no | Skip first N. Default `0` |

### Returns

JSON array of requirement entries (each has `id`, `sessionId`, `content`, `timestamp`).

### Example

```bash
ymesh mcp call query_user_requirements project_path=/Users/zoran/projects/yondermesh keyword=auth limit=10
```

## query_agent_responses

Query the extracted agent responses (assistant messages) for a project. Same filter semantics as `query_user_requirements`. Requires `extract_project_history` to have been run first.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | yes | Project path (must match the path used for `extract_project_history`) |
| `keyword` | string | no | Case-insensitive substring match on content |
| `session_id` | string | no | Filter by session ID |
| `from` | string | no | Start time (ISO 8601 or relative) |
| `to` | string | no | End time (ISO 8601 or relative) |
| `id` | number | no | Exact line ID (1-based). When set, all other filters are ignored |
| `limit` | number | no | Return cap. Default `20`, clamped to 1-500 |
| `offset` | number | no | Skip first N. Default `0` |

### Returns

JSON array of response entries (each has `id`, `sessionId`, `content`, `timestamp`).

### Example

```bash
ymesh mcp call query_agent_responses project_path=/Users/zoran/projects/yondermesh session_id=019f5fe4-... limit=20
```

## yondermesh_mailbox_post

> **(legacy v2, prefer `yondermesh_send` for sync delivery)** — v2 is async (write to SQLite, target polls). For synchronous send-and-get-reply, use [`yondermesh_send`](#yondermesh_send) instead.

Post a message to another session or broadcast to a project. Backed by `MailboxCore` (`src/mailbox/core.ts`), stored in the shared SQLite DB. Supports priority, expiry, and threading.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `body` | string | yes | Message content |
| `to_session_id` | string | no | Direct message — target session ID |
| `to_project` | string | no | Broadcast — target project path |
| `from_session_id` | string | no | Sender session ID |
| `kind` | string | no | One of `info`, `warning`, `question`, `task_update`. Default `info` |
| `priority` | string | no | One of `normal`, `urgent`. Default `normal` |
| `expires_in_seconds` | number | no | TTL; message auto-cleans after this many seconds |
| `thread_id` | string | no | Explicit thread ID; auto-derived when using `yondermesh_mailbox_reply` |

One of `to_session_id` or `to_project` is required.

### Returns

```json
{ "messageId": 42, "posted": true }
```

### Example

```bash
ymesh mcp call yondermesh_mailbox_post to_session_id=019f6a21-c... body="urgent: build broken" priority=urgent expires_in_seconds=3600
```

## yondermesh_mailbox_check

> **(legacy v2, prefer `yondermesh_send` for sync delivery)** — use this to read historical/queued messages; for live sync delivery use [`yondermesh_send`](#yondermesh_send).

Peek or pop unread messages for the current session, plus consume any daemon-pushed tray notices. This is the primary "inbox" call. When `mark_read=true` (default), messages are atomically popped and marked read; when `mark_read=false`, messages are peeked without side effects.

Self-session resolution uses three layers (in order): `YONDERMESH_SELF_SESSION_ID` env var → `self_session_id` arg → cwd match against live sessions. The first layer that resolves wins.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `self_session_id` | string | no | Explicit self session ID (overrides cwd lookup, but env var takes precedence) |
| `mark_read` | boolean | no | `true` (default) = pop semantics (read + mark read); `false` = peek (no side effects) |

### Returns

```json
{
  "sessionId": "019f6a21-...",
  "markRead": true,
  "unread": { "direct": 1, "broadcast": 0, "total": 1 },
  "trayNotices": [],
  "messages": [
    {
      "id": 42,
      "toSessionId": "019f6a21-...",
      "fromSessionId": "019f5fe4-...",
      "body": "Tests pass, ready to merge",
      "kind": "task_update",
      "priority": "normal",
      "threadId": null,
      "createdAt": 1719503600000
    }
  ],
  "hint": "📬 你有 1 条未读消息（direct 1, broadcast 0）。处理后可调 yondermesh_mailbox_post 回复。"
}
```

When self cannot be resolved, returns `isError: true`.

### Example

```bash
ymesh mcp call yondermesh_mailbox_check self_session_id=019f6a21-c... mark_read=false
```

## yondermesh_mailbox_reply

> **(legacy v2, prefer `yondermesh_send` for sync delivery)** — v2 is async (write to SQLite). For synchronous delivery use [`yondermesh_send`](#yondermesh_send) instead.

Reply to a specific message. Automatically derives `thread_id`: if the parent already has a thread, the reply inherits it; otherwise a new `thread-<parent_id>` is created.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `reply_to_id` | number | yes | ID of the message being replied to |
| `body` | string | yes | Reply body |
| `from_session_id` | string | no | Sender session ID |

### Returns

```json
{ "messageId": 43, "posted": true, "threadId": "thread-42" }
```

Returns `isError: true` if `reply_to_id` does not exist.

### Example

```bash
ymesh mcp call yondermesh_mailbox_reply reply_to_id=42 body="ack, on it" from_session_id=019f5fe4-...
```

## yondermesh_whoami

Resolve and report the current session's identity, plus an unread-message hint. Useful for an agent to confirm "who am I" at the start of a task, and to notice pending mailbox messages. Uses the same three-layer self-resolution as `yondermesh_mailbox_check`.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `self_session_id` | string | no | Explicit self session ID (overrides cwd lookup; env var still wins) |

### Returns

```json
{
  "sessionId": "019f6a21-...",
  "resolved": true,
  "unread": { "direct": 1, "broadcast": 0, "total": 1 },
  "hint": "📬 你有 1 条未读消息（direct 1, broadcast 0）。处理后可调 yondermesh_mailbox_post 回复。"
}
```

When self cannot be resolved:

```json
{
  "sessionId": null,
  "resolved": false,
  "hint": "无法解析 self session id。可通过 self_session_id 显式传入..."
}
```

### Example

```bash
ymesh mcp call yondermesh_whoami
```

## yondermesh_send

Synchronously send a user message to a target agent CLI session and return the agent's reply in the same call. This is the v3 sync-injection tool — unlike the legacy `yondermesh_mailbox_*` (v2 async, where you write to SQLite and the target polls), `yondermesh_send` immediately delivers the message through `TriggerAdapter` and captures the cleaned reply through `ReplyAdapter`.

Backed by `MailboxCore.send()` (`src/mailbox/core.ts`). The flow inside `send()`:

1. **Audit-write the user message** to `agent_messages` (kind=`question`).
2. **TriggerAdapter.trigger()** delivers the message to the target CLI via the appropriate channel (cli-spawn / stdin / http-api / ws-rpc / tmux / applescript).
3. **ReplyAdapter.extractReply()** cleans the raw `TriggerResult.response` — strips ANSI escapes, drops CLI-specific noise (e.g. hermes `Warning: Unknown toolsets:` lines, claude `Tip:` lines), removes log/banner prefixes, collapses blank lines.
4. **Audit-write the reply** to `agent_messages` (kind=`task_update`, linked via `replyToId` + `threadId`).
5. Returns `SendResult` (see below).

Even if the target agent has no model configured, auth fails, or the upstream API rate-limits, `send()` returns an error message in `response` / `error` instead of hanging.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `cli` | string | yes | Target CLI id (e.g. `hermes`, `claude`, `opencode`, `trae-ide`) |
| `message` | string | yes | User message to inject into the target agent session |
| `mode` | string | no | Delivery mode: `stopped` (resume a stopped session with the message), `running` (inject into a running session), `new` (create a new session). Default `new` |
| `session_id` | string | no | Target session id. Required for `stopped` / `running`; ignored for `new` |
| `model` | string | no | Model id for `new` sessions (e.g. `gpt-4o`, `claude-sonnet-4`) |
| `effort` | string | no | Effort level for `new` sessions (e.g. `low` / `medium` / `high`) |
| `cwd` | string | no | Working directory for the target session |
| `timeout_ms` | number | no | Timeout in milliseconds. Default `60000` |
| `from_session_id` | string | no | Sender session id (for the audit trail) |

### Returns

JSON object (`SendResult`):

```json
{
  "cli": "hermes",
  "mode": "new",
  "delivered": true,
  "response": "PONG",
  "exitCode": 0,
  "channel": "cli-spawn",
  "latencyMs": 3214,
  "newSessionId": "019f6a21-c...",
  "messageId": 21,
  "replyMessageId": 22
}
```

Fields:

- `delivered` — whether the message was successfully delivered to the target CLI (true even if the agent produced no reply).
- `response` — `ReplyAdapter`-cleaned agent reply text (may be empty string).
- `exitCode` — process exit code for `cli-spawn` channel.
- `channel` — the trigger channel actually used (`cli-spawn` / `stdin` / `http-api` / `ws-rpc` / `tmux` / `applescript`).
- `latencyMs` — total `send()` wall time (audit + trigger + reply extraction).
- `newSessionId` — present when `mode=new` and a session was created.
- `error` — failure reason; always set when `delivered=false`.
- `messageId` — audit row id of the user message (always present, even on delivery failure).
- `replyMessageId` — audit row id of the assistant reply (present only when a non-empty reply was captured).

### Failure modes

- Invalid `mode`, or `stopped`/`running` without `session_id` → `isError: true` with a validation message.
- Unknown CLI (not in `WRAPPER_LOADERS`) → `delivered: false`, `error` set, `messageId` still assigned (audit row written).
- `TriggerAdapter.trigger()` throws → caught, returns `delivered: false` with the exception text in `error`.
- Target CLI exits non-zero (e.g. upstream API 429) → `delivered: true`, `exitCode` non-zero, the CLI's own error text appears in `response` so the caller can see what went wrong.

### Example

```bash
ymesh mcp call yondermesh_send cli=hermes mode=new message="Reply with exactly the word PONG and nothing else."
```

```bash
ymesh send --cli hermes --message "hello" --mode new --json
```

See also the [`ymesh send`](./cli#send) CLI command for the same capability from the shell.

## Channel A: piggyback unread hints

When the current session has unread mailbox messages, **any** non-mailbox MCP tool response gets a `📬 mailbox: N unread` line appended to its text content. This lets an agent learn about pending messages without actively polling — the hint surfaces as a side effect of any normal tool call.

The hint is injected by `McpServer.callTool()` in `src/mcp/server.ts`. It uses `MailboxCore.countUnread()` after the primary tool executes, so it reflects the post-call state. To silence the hint, call `yondermesh_mailbox_check` with `mark_read=true` to clear the unread count.

## Related

- `/guide/mcp` — how to register the MCP server in each agent's config
- `/reference/cli` — `ymesh mcp call`, `ymesh mcp register`, `ymesh mcp status`
- `/reference/config` — the `mcp` section of `config.yaml`
