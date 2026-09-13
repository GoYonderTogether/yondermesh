---
title: MCP Tools
description: Reference for the orthogonal tool set exposed by the yondermesh MCP server (ymesh mcp) — arguments and invocation.
outline: [2, 3]
---

> **Auto-generated** from `McpServer.listTools()` in `src/mcp/server.ts`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.

The `ymesh mcp` command starts a stdio JSON-RPC server that exposes yondermesh's session graph to any MCP-capable agent (Claude Code, Codex, Cursor, Gemini, Windsurf, Continue, ...). Deprecated forwarding aliases are omitted.

**4 core orthogonal tools** — see / say / manage / label.

## How to call

### From the CLI

```bash
ymesh mcp call <tool> [key=value ...]
```

## Core tools (orthogonal set)

### observe

See — the single read entry point over every AI agent session on this machine (and, later, across devices). Pick `scope` to choose what you are looking at (me / global / project / session / active / tree), then narrow with filters; `shape` decides the output form (list / detail / summary / tree / stats). Use it before starting work so you know who is already running, and instead of post-processing results by hand — filters are part of the query.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `scope` | enum(me / global / project / session / active / tree) | yes | What to look at: me (my own session) / global / project / session / active (who is working now) / tree (session hierarchy) |
| `target` | string | no | Target for scope=session\|tree: session id (hash, native UUID or unique prefix) or project path for scope=project |
| `shape` | enum(list / detail / summary / tree / stats) | no | Output form: list / detail / summary / tree / stats |
| `roles` | array | no | Only these message roles, e.g. ["user","assistant"] — use ["user"] to read just what the human asked |
| `exclude` | array | no | Exclude roles such as ["tool"] to drop tool-call noise |
| `min_length` | number | no | Only messages with at least this many characters (e.g. 200 = long requirements only) |
| `keyword` | string | no | Fuzzy keyword match over message content |
| `since` | string | no | Only activity after this time — ISO 8601 or relative like 7d / 24h / 30m |
| `until` | string | no | Only activity before this time |
| `limit` | number | no | Max rows (default 20) (default `20`) |
| `offset` | number | no | Pagination offset (default 0) (default `0`) |
| `include_agents` | boolean | no | For scope=global, also list the detected CLIs (default `false`) |
| `self_session_id` | string | no | Explicitly state which session you are (when self-detection is ambiguous) |

### message

Say — the one entry point for talking to another agent session. You do not need to know which CLI it is, only its session id. `action=send` posts a message, `action=check` reads what was sent to me. `delivery` picks the moment: now (rejected while the target is running — injecting between its turns corrupts the session), after_turn (delivered once my own turn ends; queued messages to the same target are merged), on_reply (delivered the moment the target finishes replying to its user, phrased as if the user said it).

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `action` | enum(send / check) | yes | send = post a message, check = read messages addressed to me (default) (default `check`) |
| `to` | string | no | send: target session id (hash / native / prefix) or "all" to broadcast to my project |
| `body` | string | no | send: message body |
| `delivery` | enum(now / after_turn / on_reply) | no | send: now / after_turn / on_reply (default now) (default `now`) |
| `reply_to` | number | no | send: id of the message you are replying to (thread is derived automatically) |
| `limit` | number | no | check: max messages to return (default 20) (default `20`) |
| `mark_read` | boolean | no | check: mark returned messages as read (default true) (default `true`) |
| `unread_only` | boolean | no | check: only unread messages (default true) (default `true`) |
| `self_session_id` | string | no | check: explicitly state which session you are |

### orchestrate

Manage — what I do to sessions below me. `spawn` starts a new session, `assign` hands work to an existing one, `handoff` builds a takeover package, `await` waits for a result, `discuss` runs a multi-model debate, `stop` asks a session to stop cooperatively (never a kill — see the tool result), `prior` asks whether this was attempted before.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `action` | enum(spawn / assign / handoff / await / discuss / stop / prior) | yes | spawn / assign / handoff / await / discuss / stop / prior |
| `target` | string | no | Target session (assign/await/stop) or source session (handoff) |
| `brief` | string | no | Task description (spawn/assign/discuss) |
| `to` | array | no | discuss: which sessions to pull in (at least 2, must use different models) |
| `query` | string | no | prior: the task or error text to search for |
| `delivery` | enum(now / after_turn / on_reply) | no | spawn/assign/discuss: when to deliver — now / after_turn / on_reply (default on_reply) |
| `config` | object | no | spawn: execution config — cli / model / effort / cwd / timeout_ms |
| `limit` | number | no | await / prior: how many records to consider |
| `self_session_id` | string | no | Explicitly state which session you are |

### workspace

Label — where I record what a working directory means: a human-readable label, a group, and a note. Also answers "which agents are running under this directory right now", counting only sessions strictly below the marked path.

#### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `action` | enum(list / add / update / remove / status) | yes | add / update / remove / list / status |
| `path` | string | no | Absolute path of the working directory |
| `label` | string | no | Readable name for the directory |
| `group` | string | no | Group such as "personal" / "work" |
| `note` | string | no | Free-form note |
| `within_minutes` | number | no | status: only consider sessions seen within the last N minutes (default 30) (default `30`) |
