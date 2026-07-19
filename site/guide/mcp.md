---
title: MCP Server
description: The yondermesh MCP server exposes your session graph to any MCP-capable agent via stdio JSON-RPC — query recent work, inspect active sessions, hand off tasks, and broadcast messages across CLIs.
outline: [2, 3]
---

# MCP Server

The yondermesh MCP server is the primary read surface that AI coding agents use to query the session graph. It speaks stdio JSON-RPC (MCP protocol version `2024-11-05`) and exposes a set of tools that any MCP-capable CLI — Claude Code, Codex, Cursor, Gemini, Windsurf, and others — can call directly from a session.

The server is implemented in `src/mcp/server.ts` (the `McpServer` class). It reads from the same `SessionStore` that the daemon writes to, and additionally reads native session files on disk for live reads of running sessions. It is stateless from the agent's point of view: each `tools/call` request is an independent query, and the server holds no per-agent state between calls.

## What the MCP server is

The server is a thin JSON-RPC router over three data sources:

- The local SQLite `SessionStore` (`~/.yondermesh/yondermesh.db`) for structured session queries, stats, active-session summaries, and the cross-session message bus.
- The native CLI session files on disk (`~/.claude/projects/`, `~/.codex/sessions/`, …) for live reads of running sessions, where the database may lag a few seconds behind the file.
- The extract NDJSONL index (`~/.yondermesh/extracts/<project-hash>/`) for user-requirement and agent-response queries over a project's full history.

It implements three JSON-RPC methods: `initialize` (returns server info and capabilities), `tools/list` (returns the tool definitions), and `tools/call` (dispatches to the matching tool handler). Unknown methods return a `-32601 Method not found` error. Malformed JSON returns `-32700 Parse error`.

## Starting the server

The server runs in **stdio mode by default** — there is no HTTP transport. Start it with:

```bash
ymesh mcp
```

This connects to the local SQLite store at `~/.yondermesh/yondermesh.db` and listens on stdin/stdout for newline-delimited JSON-RPC messages. You normally do not run this manually — agents spawn it as a child process via their MCP config. You can override the database path with `--db <path>`.

## Registering into agents

`ymesh mcp register` registers the yondermesh MCP server into the two agents ymesh knows how to configure by file:

```bash
ymesh mcp register
```

This writes the server entry into:

- **Claude Code** — `~/.claude.json` under `mcpServers.yondermesh`, as a `stdio`-type entry.
- **Codex** — `~/.codex/config.toml`, appending a `[mcp_servers.yondermesh]` section with `command` and `args`.

The registration code (in `src/mcp/register.ts`) resolves the correct node binary (`process.execPath`) and the installed ymesh entry (`~/.yondermesh/bin/ymesh`, falling back to the dev `dist/bin/ymesh.js`), so you do not have to hardcode paths. After registration, new sessions in those CLIs pick up the server automatically; already-running sessions need to be restarted or reconnected.

For other MCP-capable CLIs (Cursor, Gemini, Windsurf, …) use the mount system (`ymesh mount all`) or add the JSON/TOML snippet manually — see [Agent config snippets](#agent-config-snippets) below. Trae configures MCP through its IDE settings UI, not through a file.

## Registration status

Check whether ymesh is currently registered:

```bash
ymesh mcp status
```

Reports `registered: true/false` for Claude Code and Codex along with the config file path that was inspected. Claude registration is detected by looking for `mcpServers.yondermesh` in `~/.claude.json`; Codex registration is detected by scanning `~/.codex/config.toml` for the `[mcp_servers.yondermesh]` header.

## Unregister

Remove ymesh from Claude Code and Codex config:

```bash
ymesh mcp unregister
```

This deletes the `yondermesh` entry from `~/.claude.json` and removes the `[mcp_servers.yondermesh]` block (including any `[mcp_servers.yondermesh.env]` subtable) from `~/.codex/config.toml`. It is idempotent — running it twice is safe, and unregistering when not registered simply returns `false` for that CLI without error.

## Direct tool invocation

You can call any MCP tool directly from the terminal without spawning an agent:

```bash
ymesh mcp call <tool> [args]
```

Examples:

```bash
# Quick "who is active on this machine"
ymesh mcp call list_active

# Search recent codex sessions from the last 7 days
ymesh mcp call search_sessions source=codex since=7d

# Get a compacted handoff package for a session id
ymesh mcp call handoff session_id=019f5fe4-b127-7de2-b8f1-efa45bee24cb

# Inspect a running session live, with tool calls preserved
ymesh mcp call get_session session_id=<id> live=true include_tool_calls=true

# Broadcast a heads-up to every agent in a project
ymesh mcp call mailbox action=post to_project=/Users/YOU/projects/app body="tests are red on main"
```

Arguments are passed as the tool's `arguments` object. Output is the raw tool result content (JSON or plain text, depending on the tool). This is useful for scripting, debugging, and quick inspection from a shell.

## MCP tools

The tool surface is **8 orthogonal core tools** plus 4 auxiliary tools, defined in `src/mcp/server.ts` (`McpServer.listTools()`, with the core set in the `ORTHOGONAL_TOOL_NAMES` constant). The per-argument, per-return canonical reference is auto-generated from `listTools()` — do not restate it here; see **[MCP Tools reference](/reference/mcp-tools)**.

Core tools at a glance:

| Tool | Purpose |
| --- | --- |
| `search_sessions` | Search sessions across every agent (time / project / agent / topology filters + full-text `query`). |
| `get_session` | Full message stream for one session; `live` for running sessions, `handoff_mode` for takeover, `include_relations` for topology. |
| `list_active` | Sessions active now or waiting for review, with a runtime summary. |
| `overview` | Aggregate stats over the local session store. |
| `handoff` | Compacted `HandoffPackage` for task takeover — see [Handoff packages](#handoff-packages). |
| `send` | Synchronously inject a message into a target CLI and get the reply — see [Synchronous injection](#synchronous-injection-send). |
| `mailbox` | Asynchronous cross-session message bus (post / check / reply / get). |
| `agents` | List local agent CLIs with install status, coverage, and mount capability. |

The 4 auxiliary tools (`extract_project_history`, `query_user_requirements`, `query_agent_responses`, `yondermesh_whoami`) cover project-history extraction and self-identification. Older tool names (`get_session_detail`, `get_session_handoff`, `list_active_sessions`, `who_is_working`, `get_overview`, `post_message`, `yondermesh_*`, …) remain as **deprecated forwarding aliases** so existing callers keep working.

### Relative time

Several tools accept a `since` / `from` / `to` parameter. ymesh accepts both ISO 8601 timestamps and compact relative forms:

- `7d` — 7 days ago
- `24h` — 24 hours ago
- `30m` — 30 minutes ago

Any other string is attempted as an ISO 8601 date. Unparseable input is treated as "no filter".

## Agent config snippets

Each MCP-capable CLI stores its MCP server config in a different place and format. The snippets below all launch ymesh the same way — `node` (or the `ymesh` launcher) invoked with `mcp` as the subcommand. Replace `/Users/YOU/.yondermesh/bin/ymesh` with the path printed by `which ymesh` if you installed globally.

### Claude Code

`~/.claude.json`:

```json
{
  "mcpServers": {
    "yondermesh": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"],
      "env": {}
    }
  }
}
```

Prefer `ymesh mcp register` (or `ymesh mount all`) over editing this file by hand — the registration code resolves the correct node binary and ymesh entry path for you.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.yondermesh]
command = "/usr/local/bin/node"
args = ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
    }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` (older installs may use `~/.windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
    }
  }
}
```

### Trae

Trae does **not** expose MCP config as a file ymesh can write. Configure it through the Trae IDE settings UI: add a new MCP server with command `ymesh` and args `["mcp"]`. The international (`~/.trae`) and Chinese (`~/.trae-cn`) variants are configured separately in their respective IDE instances; the same entry covers both Trae IDE and Trae Work within a variant, because they share the user-level config directory.

## Handoff packages

`handoff` (and `get_session` with `handoff_mode=true`) builds a `HandoffPackage` from the codex rollout JSONL, falling back to a simplified form for Claude Code sessions. The package is built by `src/mcp/codex-handoff.ts` and contains:

- `session_meta` — cwd, topology (`root` / `subagent`), model, CLI version, originator.
- `compacted_summaries` — codex post-compact summaries, sorted by `window_number`. The noisy `replacement_history` is stripped.
- `last_user_message` — the last real user message; system preambles such as `<user_instructions>`, `<environment_context>`, `<system_message>`, and `<system-reminder>` are skipped so you get the user's actual intent.
- `recent_messages` — the tail of the session, preserving `function_call`, `function_call_output`, and `custom_tool_call` entries (arguments and outputs truncated to 2000 characters to bound size).
- `task_plan` — extracted from the tail `update_plan` or any plan-bearing tool call; rendered as `explanation` plus a `- `-prefixed list of plan steps.
- `is_live` / `last_activity_sec_ago` — file `mtime` compared against a 2-minute liveness threshold.

This is the same package that `ymesh handoff <id>` produces on the CLI, so MCP and CLI handoffs are interchangeable.

## Cross-session message bus

The `mailbox` tool is a lightweight **asynchronous** cross-session message bus backed by the local SQLite store. Pick the operation via `action`: `post` (send a direct message or project broadcast), `check` (read unread), `reply`, or `get`. A message can be addressed either to a specific session (`to_session_id`) or to a project (`to_project`, broadcast to every agent working in that project). Messages are marked read when retrieved, so an agent polling with `mailbox action=check` only sees new messages.

This bus is local-only — it is not replicated by cross-device sync (which is [planned](/guide/sync), not yet implemented). Use it for same-machine coordination between agents (for example, one agent telling another that a test suite has gone red).

`mailbox` is asynchronous (leave a message, poll for it later). When you need a **synchronous** round-trip — ask a question and block for the answer — use `send` (below). The older `yondermesh_mailbox_*` / `post_message` / `get_messages` names remain as deprecated aliases routing through the same bus.

## Synchronous injection: `send`

`send` is the synchronous-injection entry point — it delivers a user message to any connected CLI agent and gets the reply back in the same call. This is what closes the loop the async mailbox leaves open: with `mailbox` an agent can leave a message for another agent but cannot ask a question and block for the answer; `send` can. (Older callers may know this tool as `yondermesh_send`, now a deprecated alias.)

| Argument | Required | Description |
|---|---|---|
| `cli` | yes | Target CLI id (`hermes`, `opencode`, `kimi`, `pi`, `aider`, `amp`, `antigravity`, `cline`, `codebuddy`, `continue`, `copilot`, `crush`, `cursor-ide`, `factory`, `gemini`, `goose`, `openclaw`, `openhands`, `qwen`, `trae-cli`, `trae-ide`, `vibe`, `windsurf`, …). |
| `message` | yes | The user message to inject. |
| `mode` | no | `stopped` / `running` / `new` (default `new`). |
| `session_id` | no | Required for `stopped` and `running`; ignored for `new`. |
| `model` | no | For `new` mode — pick the model. |
| `effort` | no | For `new` mode — `low` / `medium` / `high`. |
| `cwd` | no | Working directory for the target session. |
| `timeout_ms` | no | Delivery timeout, default 60000. |
| `from_session_id` | no | Sender session id (for audit). |

Returns `{ cli, mode, delivered, response, exitCode, channel, latencyMs, newSessionId, error, messageId, replyMessageId }`. `delivered` is true when the message reached the CLI (even if the reply is empty). `response` is the cleaned reply text — `ReplyAdapter` strips ANSI, drops CLI banners and log lines, and folds blank lines, so what you get back is the agent's actual answer, not its startup noise. The full thread (your message + the reply) is audit-logged into `agent_messages` (your message as `kind=question`, the reply as `kind=task_update`, linked via `replyToId` + `threadId=thread-<messageId>`).

Failure is never silent. `send` never throws (except for argument validation) and never hangs. Unknown CLI, missing model, non-zero exit, upstream API rate-limit — all surface as text in `response` or `error`, with `delivered=false`. The CLI's own error text appears in `response` so the caller can see exactly what went wrong.

The same capability is on the CLI as `ymesh send` — see [Quickstart](/guide/quickstart#talk-to-any-agent-get-a-reply) for examples. The internal architecture is in `src/mailbox/core.ts` (`MailboxCore.send`), `src/trigger/adapter.ts` (`TriggerAdapter`), and `src/trigger/reply-adapter.ts` (`ReplyAdapter`) — see [Architecture](/guide/architecture) for the four-plane model.

## Related

- [MCP Tools reference](/reference/mcp-tools) — canonical, auto-generated tool list.
- [Mount System](/guide/mount) — mount ymesh into every supported CLI at once.
- [Sessions & Topology](/guide/sessions) — the data model the MCP tools query over.
- [CLI Commands](/reference/cli) — `ymesh mcp` subcommand reference.
