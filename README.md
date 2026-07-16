# yondermesh

> **The collaboration hub of the Agent era.** One daemon, one MCP server, zero intrusion — turn every CLI agent on every device into one working whole.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docs](https://img.shields.io/badge/docs-online-blue.svg)](https://goyondertogether.github.io/yondermesh/)

**[English](README.md)** | [简体中文](README.zh-CN.md)

---

## Why yondermesh

You don't use one AI coding agent. You use Claude Code, Codex, Aider, Gemini CLI, Cursor, Windsurf, Trae, Continue, OpenCode, Hermes, and a dozen more — spread across laptop, desktop, and server. Each one is an island. Context dies at the session boundary. Agent A on your laptop has no idea what Agent B on your desktop just did. You copy-paste summaries between them, re-explain the project to each new session, and pray nothing important gets lost.

That fragmentation is the tax you pay every time you switch CLIs or machines. yondermesh is the hub that ends it.

## What it is

**yondermesh is a self-hosted Agent Context Bus — one daemon, one MCP server, zero intrusion.** It aggregates every CLI agent on every device into a single working whole: a shared working surface with cross-platform memory, cross-device real-time awareness, and the ability to hand work off without losing a beat.

- **Collect** — every session from every CLI on every device flows into one local SQLite. Your agents stop being islands and start acting as one working whole.
- **Sync** — end-to-end-encrypted cross-device sync via a self-hosted relay. Only ciphertext ever leaves your machine.
- **Query** — any agent queries any other agent's context via MCP tools. Topology-aware, source-aware, project-aware.
- **Hand off** — agent A picks up exactly where agent B stopped, even on a different machine. Sessions stop dying at the boundary; they become a continuous workflow.
- **Send** — synchronously inject a user message into any connected CLI agent and get the reply back. 28 CLIs, 6 channels (cli-spawn / stdin / http-api / ws-rpc / tmux / applescript), 3 modes (stopped / running / new). Even if the target agent has no model configured, you still get an error message instead of silence.

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

- **28 CLI adapters, one working whole** — reads native session formats from Claude Code, Codex, Hermes, Gemini, Goose, Aider, Amp, Factory, Vibe, CodeBuddy, Trae CLI, OpenCode, Qwen, OpenHands, Kimi, OpenClaw, Pi, Copilot, Crush, Cline, Continue, Antigravity, plus the IDE class (Trae IDE, Windsurf, Cursor IDE, ChatGPT). No CLI modification. Full matrix: [adapters reference](https://goyondertogether.github.io/yondermesh/reference/adapters).
- **MCP server** — tools exposed over stdio JSON-RPC; any MCP-capable agent gets cross-device context, handoff, and synchronous send.
- **Cross-device sync** — E2E-encrypted; the relay sees ciphertext only; self-host or use a shared relay.
- **Mount system** — non-invasively installs MCP servers, skills, and always-on context into each CLI's own config dir.
- **Session handoff** — extract a compacted handoff package (summaries + recent messages + task plan) and pass it to another agent.
- **Synchronous injection (Mailbox v3)** — `ymesh send` / `yondermesh_send` deliver a user message to any connected CLI and return the cleaned reply. 6 trigger channels, 3 modes (stopped / running / new, with optional `model` + `effort` for `new`). Failure is never silent: unknown CLI, missing model, upstream API rate-limit all surface as text in the response.
- **Daily briefing** — "your N agents across M devices did K tasks today, X% success rate".
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

Four planes that never cross-contaminate:

| Plane | Flow |
|---|---|
| **Local** | CLI native files → adapter → SessionStore (SQLite) → MCP server (stdio) |
| **Sync** | SessionStore → relay agent → self-hosted relay (ciphertext only) → peer device |
| **Mount** | ymesh skills / MCP config → CLI's own config dir (`~/.claude/`, `~/.codex/`, …) |
| **Trigger** | MailboxCore → TriggerAdapter (cli-spawn / stdin / http-api / ws-rpc / tmux / applescript) → target CLI → ReplyAdapter → audit log |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codemap and architectural invariants.

## CLI coverage

yondermesh reads native session formats from each CLI agent, and — through the trigger layer — can synchronously inject messages into any of the 28 supported CLIs. Mount strategies per CLI:

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

Full adapter matrix (28 CLIs, coverage levels A/B/C): [docs/reference/adapters](https://goyondertogether.github.io/yondermesh/reference/adapters)

## Configuration

`~/.yondermesh/config.yaml`:

```yaml
# Devices and agents to monitor
devices:
  - name: macbook
    agents:
      - type: claude-code
        path: ~/.claude/projects
      - type: codex
        path: ~/.codex/sessions

# Sync relay (self-host or use official cloud)
sync:
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem  # auto-generated on first run

# MCP server
mcp:
  enabled: true
  port: 0  # stdio mode by default

# Daily briefing
briefing:
  enabled: true
  output: ~/.yondermesh/briefings
```

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

- [x] **M1** — daemon + collector + local SQLite + MCP query tools + cross-device sync + briefing
- [x] **M2** — `handoff_task` (agent-to-agent task delegation, cross-device)
- [x] **Mailbox v3** — synchronous injection (`ymesh send` / `yondermesh_send`); 28 CLIs, 6 trigger channels, 3 modes
- [ ] **M3** — enterprise: audit trail, RBAC, session replay, compliance reports

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

This project follows a **docs-as-code** discipline: every code change must update the corresponding docs in the same commit. The doc-sync skill (`skills/doc-sync/`) automates the audit.

## Security

See [SECURITY.md](SECURITY.md). Threat model summary: local SQLite (no at-rest encryption), sync relay (ciphertext only), MCP stdio (local), mount (writes to CLI config dirs, never patches binaries), trigger (spawns / injects into local CLI processes only — no remote code execution).

## License

MIT — by [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether)
