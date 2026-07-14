# yondermesh

> Self-hosted Agent Context Bus — let your AI agents see each other, query each other, and hand off tasks across devices and CLIs.

## What is this?

You use multiple AI coding agents — Claude Code, Codex, Aider, Gemini CLI, OpenCode — across multiple machines. Each one is an island. Context dies at the session boundary.

**yondermesh fixes this.** One daemon, one MCP server, zero intrusion.

- **Collect** — auto-harvest sessions from every CLI agent on every device into local SQLite
- **Sync** — E2E-encrypted cross-device sync via self-hosted relay
- **Query** — any agent queries any other agent's context via MCP tools
- **Hand off** — agent A picks up where agent B left off, even on a different machine

## Quick start

```bash
# Install
npm install -g yondermesh

# Initialize (generates ~/.yondermesh/config.yaml)
ymesh init

# Start daemon (auto-scans all local agent sessions)
ymesh daemon

# Connect an agent's session path
ymesh connect claude-code

# Query recent work across all devices
ymesh query recent
```

Then add the MCP server to your agent config (`.claude/claude_desktop_config.json` or equivalent):

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

Now any agent can call `recall_recent_work`, `whats_on_device`, or `handoff_task`.

## What it does

1. **Session harvesting** — reads native session formats (Claude Code JSONL, Codex, Aider git log, etc.) incrementally into local SQLite. No CLI modification needed.
2. **Cross-device sync** — devices pair via E2E-encrypted relay. Code leaves your machine as ciphertext only.
3. **MCP tool layer** — any CLI that supports MCP gets three tools: `recall_recent_work` (query recent sessions across the mesh), `whats_on_device` (inspect a remote device's project state), `handoff_task` (delegate a task to another agent).
4. **Daily briefing** — "your 5 agents across 3 devices did 10 tasks today, 80% success rate" — a digest you can share.

## What it doesn't do

- **No UI** — config-file driven, daemon runs headless
- **No cloud lock-in** — fully self-hostable; cloud relay is optional convenience
- **No model proxy** — never touches your API keys
- **No agent modification** — reads native files, exposes MCP, that's it

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

## CLI Coverage

yondermesh 的 mount 系统把扩展（MCP server / skill / always-on 段落）挂载到各 CLI。
支持的 CLI 及其挂载策略：

| CLI | MCP 挂载 | Skill 挂载 | Always-on 注入 |
|---|---|---|---|
| codex | mcp-toml (`~/.codex/config.toml`) | skill-symlink (`~/.codex/skills/`) | `~/.codex/AGENTS.md` |
| claude-code | claude-mcp (`claude mcp add`) | — | `~/.claude/CLAUDE.md` |
| cursor | mcp-json (`~/.cursor/mcp.json`) | skill-symlink (`~/.cursor/skills/`) | `~/.cursorrules` |
| gemini | mcp-json (`~/.gemini/settings.json`) | — | `~/.gemini/GEMINI.md` |
| windsurf | mcp-json (`~/.windsurf/mcp_config.json`) | skill-symlink (`~/.windsurf/skills/`) | `~/.windsurfrules` |
| trae | — | skill-symlink (`~/.trae/skills/`) | — |
| trae-cn | — | skill-symlink (`~/.trae-cn/skills/`) | — |
| continue | — | skill-symlink (`~/.continue/skills/`) | — |

### Trae 四变体覆盖机制

Trae 实际上有四个客户端变体需要全覆盖：Trae IDE（国际版）、Trae IDE CN（中文版）、
Trae Work（国际版）、Trae Work CN（中文版）。ymesh 用 2 个 CliTarget 覆盖全部 4 个变体：

- 物理上只有 2 个用户级目录：`~/.trae`（国际版）和 `~/.trae-cn`（中文版）。
- 每个目录下 IDE 和 Work 共享用户级 `skills/` 目录（用不同 profile，但用户级 skills 是共享的）。
- 所以挂 2 个 CliTarget（`trae` + `trae-cn`）即覆盖 4 个变体（IDE + Work × 国际 + 中文）。

Trae 的挂载策略与其它 CLI 不同，需特别注意：

- **不支持 always-on 注入**：Trae 不读取 `project_rules.md` 之类的全局指令文件
  （它通过 system prompt + skills 目录注入，不读全局指令文件）。ymesh 改用
  skill-symlink 挂载 `trae-awareness` skill 来替代 always-on awareness 段落，让 Trae
  在 skill 列表里就能发现 ymesh。
- **不支持文件挂 MCP**：Trae 的 MCP 通过 IDE UI 配置，不是文件可挂。如需在 Trae 里
  使用 ymesh MCP 工具，请在 Trae 设置里手动添加 MCP server（command: `ymesh`，
  args: `["mcp"]`）。

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
  # E2E encryption key (auto-generated on first run)
  key_file: ~/.yondermesh/key.pem

# MCP server
mcp:
  enabled: true
  port: 0  # stdio mode by default

# Daily briefing
briefing:
  enabled: true
  output: ~/.yondermesh/briefings
```

## Roadmap

- [x] **M1** — daemon + collector + local SQLite + MCP query tools + cross-device sync + briefing
- [ ] **M2** — `handoff_task` (agent-to-agent task delegation, cross-device)
- [ ] **M3** — enterprise: audit trail, RBAC, session replay, compliance reports

## License

MIT — by [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether)

## Contributing

Contributions welcome. This is an open-source project by 未至之境 (Yonder).
