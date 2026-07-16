---
title: Quickstart
description: Install yondermesh, start the daemon, scan your first sessions, and connect an MCP-capable agent in under five minutes.
outline: [2, 3]
---

# Quickstart

This guide takes you from zero to a running yondermesh daemon with harvested
sessions and an MCP-connected agent in under five minutes.

## Prerequisites

- **Node.js 20 or later** — yondermesh requires `>=20.0.0`. Check with
  `node --version`.
- **macOS, Linux, or WSL** — the daemon watches filesystem events and writes to
  a local SQLite database. Native Windows is not yet supported; use WSL.
- **At least one CLI agent already installed** — Claude Code, Codex, Aider,
  Gemini CLI, Cursor, Windsurf, Continue, OpenCode, or any of the [supported
  adapters](/reference/adapters). yondermesh reads sessions the CLI has already
  written; you do not need to change how you use the CLI.

## Install

Install the `ymesh` CLI globally from npm:

```bash
npm install -g yondermesh
```

Verify the install:

```bash
ymesh version
```

If you prefer to build from source or need a pre-release, see
[Installation](/guide/installation) for the full set of options.

## Start the daemon

The daemon is the only long-running process. On first start it auto-provisions
the data directory at `~/.yondermesh/` (including the SQLite database at
`~/.yondermesh/yondermesh.db`) and runs an initial scan of every adapter it can
detect on the local machine.

```bash
ymesh daemon
```

The daemon lifecycle is: `start -> scan-once -> watch (fs events) -> periodic
reconcile -> idle`. It reads native session files only and never modifies them.
You can override the data directory with the `YONDERMESH_HOME` environment
variable if you want it somewhere other than `~/.yondermesh/`.

Leave the daemon running in one terminal. Open a second terminal for the
verification steps below.

::: tip
The daemon is the only process that writes to the SQLite store. The `ymesh` CLI
commands (`status`, `sessions`, `active`, ...) are thin read-only queries over
the same store, so they work whether or not the daemon is running — but the
store is only refreshed while the daemon is active.
:::

## Verify the scan

Check the daemon status and the most recent scan results:

```bash
ymesh status
```

List the agents yondermesh detected on this machine and their coverage status:

```bash
ymesh agents
```

List recent sessions (defaults to 20, raise the limit to see more):

```bash
ymesh sessions --limit 10
```

Filter by source or topology if you only care about one CLI:

```bash
ymesh sessions --source claude --topology root
```

See which sessions are currently active — that is, which agents are working
right now:

```bash
ymesh active
```

All of these commands accept `--json` for script consumption:

```bash
ymesh sessions --limit 10 --json
```

## Connect MCP to your agent

yondermesh ships an MCP server that speaks stdio JSON-RPC. Any MCP-capable agent
can call it. Add the server to your agent's config file.

### Claude Code (claude_desktop_config.json)

Edit `~/.claude/claude_desktop_config.json` (or the equivalent path on your
platform) and add the `yondermesh` entry under `mcpServers`:

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

You can also let yondermesh register itself into Claude Code and Codex
automatically:

```bash
ymesh mcp register
```

Check registration status at any time:

```bash
ymesh mcp status
```

### Codex (config.toml)

For Codex, add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.yondermesh]
command = "ymesh"
args = ["mcp"]
```

### Other MCP-capable CLIs

Cursor, Gemini, and Windsurf each use a JSON-based MCP config file
(`~/.cursor/mcp.json`, `~/.gemini/settings.json`, `~/.windsurf/mcp_config.json`).
The shape is the same as the Claude Code example above. You can also use the
mount system to install MCP config into all detected CLIs at once:

```bash
ymesh mount all
```

Check what is mounted where:

```bash
ymesh mount status
```

::: warning
Trae does not support file-mounted MCP. To use yondermesh MCP tools inside Trae,
add the server manually in the Trae settings UI (command: `ymesh`, args:
`["mcp"]`). See the [CLI Adapters reference](/reference/adapters) for per-CLI
mount strategy details.
:::

## Try the MCP tools

Restart your agent so it picks up the new MCP server, then ask it to call a
yondermesh tool. You can also invoke tools directly from the terminal to verify
connectivity without an agent round-trip:

```bash
ymesh mcp call who_is_working
```

The most useful tools to try first:

- `search_sessions` — returns recent sessions across the mesh. Ask your
  agent: "What did my agents work on recently?"
- `list_active_sessions` — inspects a device's project state. Ask: "What's on my
  laptop right now?"
- `who_is_working` — lists currently active sessions. Ask: "Who is working
  right now?"
- `get_session_handoff` — builds a compacted handoff package for another agent to pick
  up.

## Talk to any agent, get a reply

`ymesh send` is the synchronous injection entry point — it sends a user message
to any connected CLI agent and returns the cleaned reply, all in one call. This
is what turns yondermesh from a passive observability plane into an active
coordination plane.

```bash
# Ask a freshly-spawned hermes session a question, get the answer back
ymesh send --cli hermes --mode new --message "Summarize the latest commit on this branch in one sentence."

# Resume a stopped opencode session and ask a follow-up
ymesh send --cli opencode --session <id> --mode stopped --message "Now do the same for the previous commit."

# Inject into a running session in-place
ymesh send --cli opencode --session <id> --mode running --message "Status check: what are you doing right now?"

# Machine-readable output for scripting
ymesh send --cli hermes --mode new --message "List the open files in this repo." --json
```

`--mode` controls how the message reaches the target CLI:

- `new` (default) — launch a fresh session. Optionally pass `--model` and
  `--effort` to control the model and reasoning depth.
- `stopped` — resume a previously-stopped session with `--resume` and the
  message, then capture the reply.
- `running` — inject into a live session in-place via the CLI's stdin / API /
  tmux / applescript channel.

The reply goes through `ReplyAdapter` — a pure-function cleaner that strips
ANSI, drops CLI banners and log lines, and folds blank lines — so what you get
back is the agent's actual answer, not its startup noise. The full thread (your
message + the reply) is audit-logged into the same `agent_messages` table that
`yondermesh_mailbox_check` reads, so you can query it later.

If something goes wrong (unknown CLI, missing model, upstream API rate-limit,
non-zero exit), `send` never hangs and never throws — it returns with
`delivered=false` and the error text in the `response` field, so you can see
exactly what happened. Exit code is `0` on delivery, `2` when not delivered, `1`
on validation or unexpected errors.

MCP clients get the same capability via the `yondermesh_send` tool — see
[MCP Server](/guide/mcp) for the schema.

## Next steps

- [Architecture](/guide/architecture) — understand the four planes (local /
  sync / mount / trigger), the codemap, and the invariants that keep them clean.
- [MCP Server](/guide/mcp) — the full tool surface, request/response shapes, and
  how the server is registered into each CLI.
- [CLI Commands](/reference/cli) — the complete command reference, auto-generated
  from `ymesh help`.
- [Installation](/guide/installation) — release management, the LaunchAgent
  service on macOS, and how to uninstall.
- [CLI Adapters](/reference/adapters) — the support matrix for every CLI agent
  yondermesh can harvest sessions from.
