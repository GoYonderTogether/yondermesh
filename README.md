# yondermesh

> **Self-hosted Agent Context Bus.** One daemon, one MCP server, zero intrusion — turn every CLI agent on every device into one working whole.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docs](https://img.shields.io/badge/docs-online-blue.svg)](https://goyondertogether.github.io/yondermesh/)

**[English](README.md)** | [简体中文](README.zh-CN.md)

> **Status labels:** `shipped` = implemented and tested · `preview` = code exists but not yet released · `planned` = not implemented (design only).

---

## Why yondermesh

You don't use one AI coding agent. You use Claude Code, Codex, Aider, Gemini CLI, Cursor, Windsurf, Trae, Continue, OpenCode, Hermes, and a dozen more — spread across laptop, desktop, and server. Each one is an island. Context dies at the session boundary. Agent A on your laptop has no idea what Agent B on your desktop just did. You copy-paste summaries between them, re-explain the project to each new session, and pray nothing important gets lost.

That fragmentation is the tax you pay every time you switch CLIs or machines. yondermesh is the hub that ends it.

## What it is

**yondermesh is a self-hosted Agent Context Bus — one daemon, one MCP server, zero intrusion.** It aggregates every CLI agent on every device into a single working whole: a shared working surface with cross-platform memory, cross-device real-time awareness, and the ability to hand work off without losing a beat.

- **Collect** `shipped` — every session from every CLI on every device flows into one local SQLite. Your agents stop being islands and start acting as one working whole.
- **Sync** `planned` — end-to-end-encrypted cross-device sync via a self-hosted relay. Not yet implemented; the sync code path is a TODO stub.
- **Query** `shipped` — any agent queries any other agent's context via MCP tools. Topology-aware, source-aware, project-aware.
- **Hand off** `shipped` — agent A picks up exactly where agent B stopped, even on a different machine. Sessions stop dying at the boundary; they become a continuous workflow.
- **Send** `preview` — synchronously inject a user message into any connected CLI agent and get the reply back. 23 CLIs (Claude Code and Codex not yet wired — planned). 6 channels (cli-spawn / stdin / http-api / ws-rpc / tmux / applescript), 3 modes (stopped / running / new). Even if the target agent has no model configured, you still get an error message instead of silence.

## Quick start

```bash
# Install
npm install -g yondermesh

# Start the daemon (auto-provisions ~/.yondermesh/, auto-scans all local agent sessions)
ymesh daemon

# Check what was found
ymesh status
ymesh agents
ymesh sessions --limit 10
ymesh active   # who is working right now
```

Connect yondermesh to your agent via MCP:

```bash
# Register MCP server into Claude Code and Codex
ymesh mcp register

# Mount skills + MCP into all detected CLIs
ymesh mount all
```

Or add manually to your agent config (`.claude/claude_desktop_config.json` or equivalent):

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

Now any MCP-capable agent can call `who_is_working`, `search_sessions`, `get_session_handoff`, `yondermesh_send`, and more.

### Talk to any agent, get a reply

```bash
# Inject a question into a connected agent and get the answer back, synchronously
ymesh send --cli hermes --mode new --message "Summarize the latest commit on this branch in one sentence."

# Resume a stopped session and ask a follow-up
ymesh send --cli opencode --session <id> --mode stopped --message "Now do the same for the previous commit."
```

`ymesh send` (or the `yondermesh_send` MCP tool) is the unified entry point for synchronous message delivery. It picks the right channel for the target CLI, delivers the message, cleans the reply, and writes the full thread to the audit log — all in one call.

## Key features

- **27 CLI adapters, one working whole** — reads native session formats from Claude Code, Codex, Hermes, Gemini, Goose, Aider, Amp, Factory, Vibe, CodeBuddy, Trae CLI, OpenCode, Qwen, OpenHands, Kimi, OpenClaw, Pi, Copilot, Crush, Cline, Continue, Antigravity, plus the IDE class (Trae IDE, Windsurf, Cursor IDE, ChatGPT). No CLI modification. Full matrix: [adapters reference](https://goyondertogether.github.io/yondermesh/reference/adapters).
- **MCP server** — tools exposed over stdio JSON-RPC; any MCP-capable agent gets cross-device context, handoff, and synchronous send.
- **MCP server** — tools exposed over stdio JSON-RPC; any MCP-capable agent gets cross-device context, handoff, and synchronous send.
- **Mount system** — non-invasively installs MCP servers, skills, and always-on context into each CLI's own config dir.
- **Session handoff** `shipped` — extract a compacted handoff package (summaries + recent messages + task plan) and pass it to another agent.
- **Synchronous injection (Mailbox v3)** `preview` — `ymesh send` / `yondermesh_send` deliver a user message to any connected CLI and return the cleaned reply. 23 CLIs (Claude Code and Codex not yet wired — planned). 6 trigger channels, 3 modes (stopped / running / new, with optional `model` + `effort` for `new`). Failure is never silent: unknown CLI, missing model, upstream API rate-limit all surface as text in the response.
- **Cross-device sync** `planned` — E2E-encrypted relay design exists; the sync code path is a TODO stub, not yet functional.
- **Daily briefing** `planned` — activity digest design exists; the briefing generator is a TODO stub, not yet functional.
- **No UI, no cloud lock-in, no model proxy, no agent modification.**

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Device A (macOS)                                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ClaudeCode│  │  Codex   │  │  yondermesh daemon│  │
│  │  JSONL   │  │  session │  │  ┌─────────────┐  │  │
│  └────┬─────┘  └────┬─────┘  │  │  collector   │  │  │
│       │              │        │  │  SQLite store│  │  │
│       └──────────────┘        │  │  MCP server  │  │  │
│                                │  │  sync agent  │  │  │
│                                │  │  trigger     │  │  │
│                                │  └──────┬──────┘  │  │
│                                └─────────┼─────────┘  │
│                                          │            │
└──────────────────────────────────────────┼────────────┘
                                           │ E2E encrypted
                              ┌────────────┴────────────┐
                              │   Self-hosted relay     │
                              │   (ciphertext only)     │
                              └────────────┬────────────┘
                                           │
┌──────────────────────────────────────────┼────────────┐
│  Device B (Windows)                      │            │
│  ┌──────────┐  ┌──────────┐  ┌───────────┴──────────┐ │
│  │  Codex   │  │  Aider   │  │  yondermesh daemon   │ │
│  │  session │  │  git log │  │  queries Device A    │ │
│  └──────────┘  └──────────┘  └──────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

Four planes (three shipped, one planned):

| Plane | Flow | Status |
|---|---|---|
| **Local** | CLI native files → adapter → SessionStore (SQLite) → MCP server (stdio) | `shipped` |
| **Sync** | SessionStore → relay agent → self-hosted relay (ciphertext only) → peer device | `planned` |
| **Mount** | ymesh skills / MCP config → CLI's own config dir (`~/.claude/`, `~/.codex/`, …) | `shipped` |
| **Trigger** | MailboxCore → TriggerAdapter (cli-spawn / stdin / http-api / ws-rpc / tmux / applescript) → target CLI → ReplyAdapter → audit log | `preview` |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codemap and architectural invariants.

## CLI coverage

yondermesh reads native session formats from each CLI agent, and — through the trigger layer — can synchronously inject messages into 23 of those CLIs. Mount strategies per CLI:

| CLI | MCP mount | Skill mount | Always-on injection |
|---|---|---|---|
| codex | mcp-toml (`~/.codex/config.toml`) | skill-symlink (`~/.codex/skills/`) | `~/.codex/AGENTS.md` |
| claude-code | claude-mcp (`claude mcp add`) | — | `~/.claude/CLAUDE.md` |
| cursor | mcp-json (`~/.cursor/mcp.json`) | skill-symlink (`~/.cursor/skills/`) | `~/.cursorrules` |
| gemini | mcp-json (`~/.gemini/settings.json`) | — | `~/.gemini/GEMINI.md` |
| windsurf | mcp-json (`~/.windsurf/mcp_config.json`) | skill-symlink (`~/.windsurf/skills/`) | `~/.windsurfrules` |
| trae | — | skill-symlink (`~/.trae/skills/`) | — |
| trae-cn | — | skill-symlink (`~/.trae-cn/skills/`) | — |
| continue | — | skill-symlink (`~/.continue/skills/`) | — |

Full adapter matrix (27 CLIs, coverage levels A/B/C): [docs/reference/adapters](https://goyondertogether.github.io/yondermesh/reference/adapters)

## Configuration

> `planned` — The daemon does **not** currently parse `config.yaml`. It uses built-in defaults defined in `src/daemon/config.ts`. The fields below are the ones actually active today.

| Setting | Default | Override |
|---|---|---|
| Data directory | `~/.yondermesh` | `YONDERMESH_HOME=/path/to/dir` |
| SQLite DB | `<data-dir>/yondermesh.db` | `--db <path>` CLI flag |
| Reconcile interval | `60000` ms (1 min) | — |
| Watch debounce | `1000` ms | — |
| Auto-mount extensions | `true` | — |
| Skip cass adapter | `false` | — |
| Skip Claude live watcher | `false` | — |
| Skip Codex live watcher | `false` | — |

A `config.yaml` with `devices`, `sync`, `mcp`, and `briefing` sections is the design target, not a working configuration today.

## Documentation

Full documentation: **https://goyondertogether.github.io/yondermesh/**

- [Quickstart](https://goyondertogether.github.io/yondermesh/guide/quickstart)
- [Architecture](https://goyondertogether.github.io/yondermesh/guide/architecture)
- [CLI Reference](https://goyondertogether.github.io/yondermesh/reference/cli)
- [MCP Tools](https://goyondertogether.github.io/yondermesh/reference/mcp-tools)
- [Adapter Matrix](https://goyondertogether.github.io/yondermesh/reference/adapters)
- [Configuration](https://goyondertogether.github.io/yondermesh/reference/config)

## What it doesn't do

- **No UI** — config-file driven, daemon runs headless
- **No cloud lock-in** — fully self-hostable; cloud relay is optional convenience
- **No model proxy** — never touches your API keys
- **No agent modification** — reads native files, exposes MCP, that's it

## Roadmap

- [x] **M1** — daemon + collector + local SQLite + MCP query tools
- [x] **M2** — session handoff (`get_session_handoff`, `ymesh handoff`)
- [x] **Mailbox v3** — synchronous injection (`ymesh send` / `yondermesh_send`); 23 CLIs, 6 trigger channels, 3 modes
- [ ] **M3** — enterprise: audit trail, RBAC, session replay, compliance reports
- `planned` **Cross-device sync** — E2E-encrypted relay; sync code path is a TODO stub
- `planned` **Daily briefing** — activity digest; generator is a TODO stub
- `planned` **config.yaml parsing** — daemon currently uses built-in defaults only

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

This project follows a **docs-as-code** discipline: every code change must update the corresponding docs in the same commit. The doc-sync skill (`skills/doc-sync/`) automates the audit.

## Security

See [SECURITY.md](SECURITY.md). Threat model summary: local SQLite (no at-rest encryption), sync relay (ciphertext only), MCP stdio (local), mount (writes to CLI config dirs, never patches binaries), trigger (spawns / injects into local CLI processes only — no remote code execution).

## License

MIT — by [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether)
