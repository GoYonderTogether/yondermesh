# yondermesh

> Self-hosted Agent Context Bus — let your AI agents see each other, query each other, and hand off tasks across devices and CLIs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docs](https://img.shields.io/badge/docs-online-blue.svg)](https://goyondertogether.github.io/yondermesh/)

**[English](README.md)** | [简体中文](README.zh-CN.md)

---

## The problem

You use multiple AI coding agents — Claude Code, Codex, Aider, Gemini CLI, Cursor, Windsurf, Trae, Continue — across multiple machines. Each one is an island. Context dies at the session boundary. Agent A on your laptop has no idea what Agent B on your desktop just did.

## The solution

**yondermesh fixes this.** One daemon, one MCP server, zero intrusion.

- **Collect** — auto-harvest sessions from every CLI agent on every device into local SQLite
- **Sync** — E2E-encrypted cross-device sync via self-hosted relay (ciphertext only leaves your machine)
- **Query** — any agent queries any other agent's context via MCP tools
- **Hand off** — agent A picks up where agent B left off, even on a different machine

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

Now any MCP-capable agent can call `who_is_working`, `search_sessions`, `get_session_handoff`, and more.

## Key features

- **27+ CLI adapters** — reads native session formats (Claude Code JSONL, Codex, Aider, Gemini, Goose, OpenHands, Cline, Crush, Pi, Qwen, Trae, Continue, …) without modifying the CLI
- **MCP server** — 12 tools exposed over stdio JSON-RPC; any MCP-capable agent gets cross-device context
- **Cross-device sync** — E2E-encrypted; the relay sees ciphertext only; self-host or use a shared relay
- **Mount system** — non-invasively installs MCP servers, skills, and always-on context into each CLI's own config dir
- **Session handoff** — extract a compacted handoff package (summaries + recent messages + task plan) and pass it to another agent
- **Daily briefing** — "your N agents across M devices did K tasks today, X% success rate"
- **No UI, no cloud lock-in, no model proxy, no agent modification**

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

Three planes that never cross-contaminate:

| Plane | Flow |
|---|---|
| **Local** | CLI native files → adapter → SessionStore (SQLite) → MCP server (stdio) |
| **Sync** | SessionStore → relay agent → self-hosted relay (ciphertext only) → peer device |
| **Mount** | ymesh skills / MCP config → CLI's own config dir (`~/.claude/`, `~/.codex/`, …) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codemap and architectural invariants.

## CLI coverage

yondermesh reads native session formats from each CLI agent. Mount strategies per CLI:

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

Full adapter matrix (27+ CLIs, coverage levels A/B/C): [docs/reference/adapters](https://goyondertogether.github.io/yondermesh/reference/adapters)

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
- [ ] **M2** — `handoff_task` (agent-to-agent task delegation, cross-device)
- [ ] **M3** — enterprise: audit trail, RBAC, session replay, compliance reports

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

This project follows a **docs-as-code** discipline: every code change must update the corresponding docs in the same commit. The doc-sync skill (`skills/doc-sync/`) automates the audit.

## Security

See [SECURITY.md](SECURITY.md). Threat model summary: local SQLite (no at-rest encryption), sync relay (ciphertext only), MCP stdio (local), mount (writes to CLI config dirs, never patches binaries).

## License

MIT — by [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether)
