---
title: FAQ
description: Frequently asked questions about yondermesh — privacy, scope, supported agents, sync, and lifecycle.
outline: [2, 3]
---

# FAQ

Frequently asked questions about yondermesh. Answers are grounded in the
[README](https://github.com/GoYonderTogether/yondermesh/blob/main/README.md),
[ARCHITECTURE](https://github.com/GoYonderTogether/yondermesh/blob/main/ARCHITECTURE.md),
and [SECURITY](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
documents. For broken setups, see [Troubleshooting](/guide/troubleshooting).

## Q: Does yondermesh send my code to a cloud?

No. yondermesh is **self-hosted and local-first**. Sessions are stored in a
local SQLite file at `~/.yondermesh/yondermesh.db`. The only thing that ever
leaves your device is **ciphertext** destined for the cross-device sync relay
— and that relay is something you run yourself. Even if you opt into the
official cloud relay as a convenience, it sees only ciphertext; the E2E
encryption key lives on your devices in `~/.yondermesh/key.pem` and never
leaves them.

## Q: Does yondermesh touch my API keys?

No. yondermesh never proxies model calls. The CLI agent (Claude Code, Codex,
Aider, …) talks to the model vendor directly with your own API key. yondermesh
only reads the session files the CLI wrote afterward. The architectural
invariant is "no model proxy" — yondermesh has no place to put an API key even
if it wanted to.

## Q: Do I need to modify my CLI agents?

No. yondermesh reads native session files (JSONL, SQLite, git log, etc.)
without modifying them. The [mount system](/guide/mount) installs extensions
(MCP server registration, skill symlinks, always-on paragraphs) into each
CLI's **own config directory** (`~/.claude/`, `~/.codex/`, `~/.cursor/`, …) —
it never patches the CLI binary or its session writer.

## Q: Which CLI agents are supported?

See the [adapter matrix](/reference/adapters) for the live list. As of v0.1.0
the matrix has **22 A-level native importers** (read the CLI's native session
files directly) and **4 C-level extractors** (partial coverage, e.g. live
transcript hooks). New adapters land regularly — the matrix is auto-regenerated
from `src/*/` on every commit.

## Q: Does it work on Windows?

macOS and Linux are the primary platforms. Windows works via WSL — run the
daemon and CLI inside a WSL distribution and point `devices[].agents[].path`
at the WSL filesystem paths. Native Windows support is on the roadmap but not
yet shipped.

## Q: Is there a UI?

No. yondermesh is config-file driven and runs headless. The user-facing
surface is three things:

- The **daemon** (`ymesh daemon`) — runs in the background, harvests sessions.
- The **CLI** (`ymesh <command>`) — direct queries, mounts, handoffs, etc.
- The **MCP server** (`ymesh mcp`) — exposes query tools to any MCP-capable
  agent.

The docs site you are reading is for humans learning about yondermesh, not for
operating it.

## Q: How does cross-device sync work?

End-to-end encrypted. Each device has its own `~/.yondermesh/key.pem`. The
sync agent reads new sessions from the local `SessionStore`, encrypts them
with the local key, and pushes ciphertext to the self-hosted relay. Peer
devices pull ciphertext and decrypt with their own key. The relay sees only
ciphertext, source/destination device ids, and message sizes — never session
content. See [Cross-device Sync](/guide/sync) for configuration.

## Q: How do I hand off a task from one agent to another?

Two ways:

```bash
# From the CLI: extract a compacted handoff package for a session
ymesh handoff <session-id>
ymesh handoff <session-id> --json --tail 50
```

Or, from inside any MCP-capable agent, call the `handoff_task` MCP tool — it
returns the same compacted handoff package (summary + recent tool calls +
plan) as JSON, ready to inject into the receiving agent.

See [CLI Commands](/reference/cli) for `ymesh handoff` flags and
[MCP Tools](/reference/mcp-tools) for the `handoff_task` schema.

## Q: How do I add a new CLI adapter?

Create `src/<cli-name>/` with an `importer.ts` that reads the CLI's native
session format into `SessionStore`. Then register it in `cmdScan()` inside
`src/bin/ymesh.ts` so `ymesh scan` invokes it. Finally, run
`npm run sync --prefix site` to regenerate the adapter matrix. The full
procedure (including tests and doc-sync gates) is in
[Contributing](/guide/contributing) and the "Adding a New Adapter" section of
the [adapter matrix](/reference/adapters).

## Q: What's the difference between trae and trae-cn?

Trae actually has four client variants: Trae IDE (international), Trae IDE CN
(Chinese), Trae Work (international), and Trae Work CN (Chinese). ymesh
covers all four with just **2 CliTargets** — `~/.trae` (international) and
`~/.trae-cn` (Chinese) — because the IDE and Work variants in each locale
share the same user-level `skills/` directory. See [Mount System](/guide/mount)
for the full mount table.

## Q: How do I run yondermesh as a background service?

On macOS, install a LaunchAgent:

```bash
ymesh service install     # installs the LaunchAgent plist
ymesh service start       # starts the daemon on login
ymesh service status      # checks whether it's running
```

Use `ymesh service stop` to halt and `ymesh service uninstall` to remove the
LaunchAgent. On Linux, use systemd or your process manager of choice to wrap
`ymesh daemon`. See [Daemon](/guide/daemon) for details.

## Q: How do I update yondermesh?

```bash
ymesh update              # pulls from git, builds, installs, atomically swaps the symlink
ymesh rollback            # reverts to the previous release if something went wrong
ymesh releases            # lists all installed releases
```

`ymesh update` performs an atomic symlink swap and auto-rolls back if the new
build fails to start. See [CLI Commands](/reference/cli) for the full set of
release commands.

## Q: Where is my data stored?

Under `~/.yondermesh/`:

| Path | Purpose |
|---|---|
| `~/.yondermesh/yondermesh.db` | Local SQLite — every harvested session |
| `~/.yondermesh/config.yaml` | Devices, agents, sync relay, MCP, briefing config |
| `~/.yondermesh/key.pem` | E2E encryption key for cross-device sync |
| `~/.yondermesh/logs/` | Daemon and CLI logs |
| `~/.yondermesh/releases/<version>/` | Installed releases |
| `~/.yondermesh/bin/ymesh` | Symlink to the current release |
| `~/.yondermesh/briefings/` | Daily briefing output |

See [File Layout](/reference/files) for the full tree.

## Q: How do I completely reset yondermesh?

```bash
ymesh service stop                # stop the daemon if running
mv ~/.yondermesh/yondermesh.db ~/.yondermesh/yondermesh.db.bak
ymesh scan                        # rebuild the DB from native session files
```

This rebuilds the local SQLite from scratch. Sync state on the relay is not
affected — paired devices will re-push their sessions on the next sync cycle.

## Q: Is there a daily digest?

Yes. The briefing generator writes a daily digest to
`~/.yondermesh/briefings/` summarizing agent activity across all devices
("your N agents across M devices did K tasks today, X% success rate"). Enable
or disable it in `config.yaml`:

```yaml
briefing:
  enabled: true
  output: ~/.yondermesh/briefings
```

## Q: Where do I report bugs?

Open an issue at
[github.com/GoYonderTogether/yondermesh/issues](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=bug&template=bug_report.md).
For security issues, follow the private disclosure process in
[SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md) —
do **not** open a public issue for security vulnerabilities.

## Q: How is yondermesh licensed?

MIT, by [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether).
Contributions are welcome — see [Contributing](/guide/contributing).
