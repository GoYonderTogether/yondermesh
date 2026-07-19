---
title: MCP Tools
description: Reference for the orthogonal tool set exposed by the yondermesh MCP server (ymesh mcp) — arguments and invocation.
outline: [2, 3]
---

> **Auto-generated** from `McpServer.listTools()` in `src/mcp/server.ts`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.

The `ymesh mcp` command starts a stdio JSON-RPC server that exposes yondermesh's session graph to any MCP-capable agent (Claude Code, Codex, Cursor, Gemini, Windsurf, Continue, ...). Deprecated forwarding aliases are omitted.

**8 core orthogonal tools**, plus 4 auxiliary tools (project-history extraction / whoami).

## How to call

### From the CLI

```bash
ymesh mcp call <tool> [key=value ...]
```

## Core tools (orthogonal set)

### search_sessions

Search session records across every AI agent on this device. Filter by time range, project path, agent type, and session type; supports full-text `query` search over message bodies. Use it before starting a new task to find related history, or to review all work on a project.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | no | Full-text search, case-insensitive, matches message bodies |
| `search` | string | no | Alias of query |
| `source` | string | no | Filter by agent type (claude/codex/hermes …); equivalent to the old `agent` param |
| `project_path` | string | no | Exact project path match |
| `project_prefix` | string | no | Project path prefix |
| `agent` | enum(claude / codex / opencode / hermes / kimi / cursor / copilot / gemini) | no | Filter by agent type (legacy alias, same as source) |
| `topology` | enum(root / subagent) | no | root = a real user-initiated session; subagent = spawned by another agent |
| `since` | string | no | Start time, ISO 8601 or relative like 7d / 24h / 30m |
| `limit` | number | no | Return count (default `20`) |

### get_session

Return the full message stream of a session. Supports live mode (reads the source file for real-time content), handoff_mode (task takeover), and include_relations (parent/child/related topology). Merges the old get_session_detail + get_session_relations + yondermesh_get_session.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session ID |
| `live` | boolean | no | Read the source file directly for real-time content (running sessions return latest) |
| `limit` | number | no | Return only the last N messages |
| `include_compacted` | boolean | no | In live mode, attach codex compacted summaries (default `false`) |
| `include_tool_calls` | boolean | no | In live mode, preserve function_call blocks (default `false`) |
| `handoff_mode` | boolean | no | Shorthand for live + compacted + tool_calls + last 30 messages (default `false`) |
| `include_relations` | boolean | no | Attach parent/child/related session topology (default `false`) |

### list_active

List AI agent sessions currently active or waiting for user review. Merges the old list_active_sessions + who_is_working + who_is_waiting, with live/idle/stopped counts and a per-session runtime summary. Queries the DB directly; reflects state within the most recent scan cycle.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `within_minutes` | number | no | Look back this many minutes for activity (default `30`) |
| `include_waiting` | boolean | no | Also include sessions waiting for user review (default `true`) |

### overview

Statistical overview of all AI agent sessions on this device (total / root / subagent / message counts, etc.). Merges the old get_overview.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `since` | string | no | Only count data after this time |
| `project_prefix` | string | no | Only count matching projects |

### handoff

Build a compacted handoff package for task takeover. Reads the source file directly and returns codex-compacted summaries, recent tail, task_plan, session metadata, and active status. Merges the old get_session_handoff.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Session ID (required) |
| `tail_messages` | number | no | Number of tail messages including tool calls (default `30`) |

### send

Synchronously inject a user message into a target agent CLI session and get the reply. Three modes: new (start a session) / running (inject into a running session) / stopped (resume a stopped session). Merges the old yondermesh_send + launch_agent + inject_session + transfer_session.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `cli` | string | yes | Target CLI id (e.g. hermes/claude/opencode) |
| `message` | string | yes | User message |
| `mode` | enum(new / running / stopped) | no | Delivery mode (default `new`) |
| `session_id` | string | no | Target session id (required for stopped/running modes) |
| `model` | string | no | Model id (optional) |
| `effort` | string | no | Reasoning effort (optional) |
| `cwd` | string | no | Working directory (optional) |
| `timeout_ms` | number | no | Timeout in milliseconds, default 60000 |
| `from_session_id` | string | no | Sender session id (for audit) |

### mailbox

Asynchronous message read/write. Choose the operation via `action`: post (send/broadcast) / check (read unread) / reply / get (fetch). Merges the old post_message + get_messages + yondermesh_mailbox_*.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `action` | enum(post / check / reply / get) | no | Operation (default `check`) |
| `to_session_id` | string | no | post: target session |
| `to_project` | string | no | post: target project (broadcast) |
| `from_session_id` | string | no | post/reply: sender |
| `body` | string | no | post/reply: message body |
| `kind` | enum(info / warning / question / task_update) | no | Message type (default `info`) |
| `priority` | enum(low / normal / high / urgent) | no | Priority (default `normal`) |
| `reply_to_id` | number | no | reply: id of the message being replied to |
| `self_session_id` | string | no | check/get: explicit own session |
| `mark_read` | boolean | no | check: mark as read (default `true`) |

### agents

List local agent CLIs with install status, coverage level, and mount capability; optionally include mount detail. Merges the old yondermesh_list_agents + yondermesh_mount_status.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `installed_only` | boolean | no | Return only installed CLIs (default `true`) |
| `include_mounts` | boolean | no | Attach per-CLI mount detail (default `false`) |

## Auxiliary tools

### extract_project_history

Extract user requirements (user messages) and agent responses (assistant messages) from all session history of a project into indexable NDJSONL files. The first step to understanding real user needs on a project. With force_refresh=false and existing results, returns current stats without re-extracting.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | yes | Project path (cwd prefix match) |
| `force_refresh` | boolean | no | true forces re-extraction; false returns existing stats if present (default `false`) |

### query_user_requirements

Query a project's user requirements (user messages). Filter by keyword, session, time, or ID. Each entry has id, sessionId, content, timestamp. Requires extract_project_history first.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | yes | Project path (must match the extract call) |
| `keyword` | string | no | Fuzzy keyword match (case-insensitive, matches content) |
| `session_id` | string | no | Filter by session ID |
| `from` | string | no | Start time, ISO 8601 or relative like 7d / 24h / 30m |
| `to` | string | no | End time, ISO 8601 or relative |
| `limit` | number | no | Max return count (default `20`) |
| `offset` | number | no | Skip first N (default `0`) |
| `id` | number | no | Query by exact ID (= line number, 1-based); ignores other filters when matched |

### query_agent_responses

Query a project's agent responses (assistant messages). Filter by keyword, session, time, or ID. Requires extract_project_history first.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `project_path` | string | yes | Project path (must match the extract call) |
| `keyword` | string | no | Fuzzy keyword match (case-insensitive, matches content) |
| `session_id` | string | no | Filter by session ID |
| `from` | string | no | Start time, ISO 8601 or relative like 7d / 24h / 30m |
| `to` | string | no | End time, ISO 8601 or relative |
| `limit` | number | no | Max return count (default `20`) |
| `offset` | number | no | Skip first N (default `0`) |
| `id` | number | no | Query by exact ID (= line number, 1-based); ignores other filters when matched |

### yondermesh_whoami

Resolve your own session id via 3-layer fallback: (1) env YONDERMESH_SELF_SESSION_ID, (2) self_session_id arg, (3) match cwd against recently active sessions in the store. Also reports your current unread message count. Use this at the start of any task to know who you are and whether other agents have sent you messages.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `self_session_id` | string | no | Explicitly pass your session id (fallback when env var is not set) |
