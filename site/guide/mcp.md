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
# Quick "who is on this machine" summary
ymesh mcp call who_is_working

# Search recent codex sessions from the last 7 days
ymesh mcp call search_sessions --agent codex --since 7d

# Get a compacted handoff package for a session id
ymesh mcp call get_session_handoff --session-id 019f5fe4-b127-7de2-b8f1-efa45bee24cb

# Inspect a running session live, with tool calls preserved
ymesh mcp call get_session_detail --session-id <id> --live --include-tool-calls

# Broadcast a heads-up to every agent in a project
ymesh mcp call post_message --to-project /Users/YOU/projects/app --body "tests are red on main"
```

Arguments are passed as the tool's `arguments` object. Output is the raw tool result content (JSON or plain text, depending on the tool). This is useful for scripting, debugging, and quick inspection from a shell.

## MCP tools

The full tool list is defined in `src/mcp/server.ts` (`McpServer.listTools()`). The canonical reference page is [MCP Tools](/reference/mcp-tools).

| Tool | Key arguments | What it returns |
|---|---|---|
| `search_sessions` | `project_path`, `project_prefix`, `agent`, `topology`, `since`, `limit` | Sessions matching the filter, each as a summary (id, source, project, cwd, topology, message count, started/last-seen timestamps, model, CLI version, originator). `limit` defaults to 20 and is clamped to 1–200. |
| `get_session_detail` | `session_id` (required), `live`, `limit`, `include_compacted`, `include_tool_calls`, `handoff_mode` | Message list for a session. `live=true` reads the native source file directly so running sessions return their latest messages. `handoff_mode=true` is shorthand for `live + include_compacted + include_tool_calls + tail 30`, designed for task takeover. |
| `get_session_handoff` | `session_id` (required), `tail_messages` (default 30) | A compacted `HandoffPackage` — see [Handoff packages](#handoff-packages). Built by `src/mcp/codex-handoff.ts`. |
| `get_session_relations` | `session_id` (required) | Parent, child, and related sessions for the given id, with direction (`incoming` / `outgoing`) and relation type. |
| `get_overview` | `since`, `project_prefix` | Aggregate stats over the local session store (counts by source, topology, time buckets). |
| `list_active_sessions` | `within_minutes` (default 30) | Sessions with activity in the window, plus a runtime summary (total active, live count, subagent count, by-source breakdown). Direct store query, reflects the most recent scan cycle. |
| `who_is_working` | — | Human-readable summary of which agents are currently active on this machine: per-session line with `[live]` tag, source, cwd, last-seen relative time, and a by-source footer. |
| `post_message` | `body` (required), `to_session_id` or `to_project`, `from_session_id`, `kind` | Broadcasts a message to another session (direct) or to all agents in a project (broadcast). `kind` is `info` / `warning` / `question` / `task_update`. Delivered via local SQLite. |
| `get_messages` | `for_session_id` or `for_project`, `since_minutes` (default 60), `unread_only` | Messages addressed to the session or project, marked read on retrieval. Counterpart to `post_message`. |
| `extract_project_history` | `project_path` (required), `force_refresh` | Extracts every user requirement and assistant response for a project to indexed NDJSONL files under `~/.yondermesh/extracts/<hash>/`. Returns counts. With `force_refresh=false` and an existing index, returns the existing stats without re-extracting. |
| `query_user_requirements` | `project_path` (required), `keyword`, `session_id`, `from`, `to`, `limit`, `offset`, `id` | User messages extracted by `extract_project_history`. Each entry carries an `id` (1-based line number), session id, content, and timestamp. `id` short-circuits other filters. |
| `query_agent_responses` | `project_path` (required), `keyword`, `session_id`, `from`, `to`, `limit`, `offset`, `id` | Assistant messages extracted by `extract_project_history`. Same query shape as `query_user_requirements`. |

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

`get_session_handoff` and `get_session_detail` (with `handoff_mode=true`) build a `HandoffPackage` from the codex rollout JSONL, falling back to a simplified form for Claude Code sessions. The package is built by `src/mcp/codex-handoff.ts` and contains:

- `session_meta` — cwd, topology (`root` / `subagent`), model, CLI version, originator.
- `compacted_summaries` — codex post-compact summaries, sorted by `window_number`. The noisy `replacement_history` is stripped.
- `last_user_message` — the last real user message; system preambles such as `<user_instructions>`, `<environment_context>`, `<system_message>`, and `<system-reminder>` are skipped so you get the user's actual intent.
- `recent_messages` — the tail of the session, preserving `function_call`, `function_call_output`, and `custom_tool_call` entries (arguments and outputs truncated to 2000 characters to bound size).
- `task_plan` — extracted from the tail `update_plan` or any plan-bearing tool call; rendered as `explanation` plus a `- `-prefixed list of plan steps.
- `is_live` / `last_activity_sec_ago` — file `mtime` compared against a 2-minute liveness threshold.

This is the same package that `ymesh handoff <id>` produces on the CLI, so MCP and CLI handoffs are interchangeable.

## Cross-session message bus

`post_message` and `get_messages` together form a lightweight cross-session message bus backed by the local SQLite store. A message can be addressed either to a specific session (`to_session_id`) or to a project (`to_project`, broadcast to every agent working in that project). Messages are marked read automatically when `get_messages` retrieves them, so an agent polling with `get_messages --for-session-id <self>` will only see new messages.

This bus is local-only — it is not replicated by cross-device sync. Use it for same-machine coordination between agents (for example, one agent telling another that a test suite has gone red).

## Related

- [MCP Tools reference](/reference/mcp-tools) — canonical, auto-generated tool list.
- [Mount System](/guide/mount) — mount ymesh into every supported CLI at once.
- [Sessions & Topology](/guide/sessions) — the data model the MCP tools query over.
- [CLI Commands](/reference/cli) — `ymesh mcp` subcommand reference.
