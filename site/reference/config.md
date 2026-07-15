---
title: Configuration
description: Complete reference for the yondermesh config.yaml file — devices, sync, MCP server, briefing, daemon tuning, and runtime environment variables.
outline: [2, 3]
---

# Configuration

yondermesh is config-file driven. The daemon, MCP server, sync agent, and briefing generator all read from a single YAML file at `~/.yondermesh/config.yaml`. This page documents every section and field.

## Location

The config file lives at `<data-dir>/config.yaml`. The default data directory is `~/.yondermesh/`; override it with the `YONDERMESH_HOME` environment variable.

| Setting | Default | Override |
|---|---|---|
| Data directory | `~/.yondermesh` | `YONDERMESH_HOME=/path/to/dir` |
| Config file | `<data-dir>/config.yaml` | (none — always inside data dir) |
| SQLite DB | `<data-dir>/yondermesh.db` | `--db <path>` CLI flag |
| PID file | `<data-dir>/daemon.pid` | `--pid-file <path>` CLI flag |

`ymesh init` generates a starter config with sensible defaults. Re-run it after upgrading to surface any new fields. The `--db` and `--pid-file` CLI flags are per-invocation overrides; they do not edit the config file.

## Full example

```yaml
# Devices and agents to monitor
devices:
  - name: macbook
    agents:
      - type: claude-code
        path: ~/.claude/projects
      - type: codex
        path: ~/.codex/sessions
      - type: aider
        path: ~/projects/myapp       # aider reads git log under cwd

# Cross-device sync (self-host or use official cloud relay)
sync:
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem   # auto-generated on first run

# MCP server
mcp:
  enabled: true
  port: 0                           # 0 = stdio mode (default)

# Daily briefing
briefing:
  enabled: true
  output: ~/.yondermesh/briefings

# Daemon tuning (optional — defaults shown)
daemon:
  reconcile_interval_ms: 60000      # periodic full-scan interval
  debounce_ms: 1000                 # fs-event watch debounce
  auto_mount: true                  # auto-mount extensions on new sessions
  skip_cass: false                  # skip cass adapter (e.g. if DB missing)
  skip_claude: false
  skip_codex: false
```

## devices

List of devices and the agent sessions to harvest from each. Each device has a friendly `name` and an `agents` array; each agent entry tells yondermesh which adapter to use and where the native session files live.

```yaml
devices:
  - name: macbook
    agents:
      - type: claude-code
        path: ~/.claude/projects
      - type: codex
        path: ~/.codex/sessions
  - name: winbox
    agents:
      - type: gemini
        path: ~/.gemini
```

| Field | Type | Required | Description |
|---|---|---|---|
| `devices[].name` | string | yes | Friendly device identifier (used in briefings, sync logs) |
| `devices[].agents[].type` | string | yes | Adapter ID. See `/reference/adapters` for the full list (`claude-code`, `codex`, `aider`, `gemini`, `cursor`, `windsurf`, `trae`, `continue`, `cass`, `hermes`, `opencode`, `kimi`, ...) |
| `devices[].agents[].path` | string | yes | Absolute path to the CLI's native session directory. `~` is expanded. |

The adapter `type` maps to a canonical source ID inside the store (e.g. `claude-code` -> `claude`). Aliases are normalized by `src/store/source-aliases.ts`.

## sync

Cross-device sync configuration. When present, the daemon's sync agent encrypts new sessions with the local key and pushes ciphertext to the relay; peer updates are pulled and decrypted on the other side.

```yaml
sync:
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sync.relay_url` | string | yes | HTTPS URL of the self-hosted relay. Cloud relay is optional convenience and never sees plaintext. |
| `sync.key_file` | string | yes | Path to the E2E encryption key (PEM). Auto-generated on first run if missing. |

Architectural invariant: ciphertext only leaves the device. See `/guide/sync` for the relay protocol and how to self-host.

## mcp

MCP server configuration. yondermesh speaks stdio JSON-RPC by default — agents connect via `command: ymesh, args: ["mcp"]`.

```yaml
mcp:
  enabled: true
  port: 0   # 0 = stdio (default); >0 = TCP listener
```

| Field | Type | Default | Description |
|---|---|---|---|
| `mcp.enabled` | boolean | `true` | Whether the daemon spawns the MCP server |
| `mcp.port` | number | `0` | `0` = stdio JSON-RPC (recommended). A positive value binds a TCP port for HTTP/SSE clients. |

See `/reference/mcp-tools` for the canonical tool list and `/guide/mcp` for registration into Claude Code, Codex, Cursor, and others.

## briefing

Daily digest generator. Produces a human-readable summary of agent activity across all devices over the last 24h.

```yaml
briefing:
  enabled: true
  output: ~/.yondermesh/briefings
```

| Field | Type | Default | Description |
|---|---|---|---|
| `briefing.enabled` | boolean | `true` | Whether the daemon writes a daily briefing |
| `briefing.output` | string | `~/.yondermesh/briefings` | Directory where dated briefing files are written |

## daemon

Optional tuning knobs for the daemon's scan/watch loop. All fields default to the values shown; omit the section entirely to accept defaults. These fields mirror `DaemonConfig` in `src/daemon/config.ts`.

| Field | Type | Default | Description |
|---|---|---|---|
| `daemon.reconcile_interval_ms` | number | `60000` | Periodic full-scan interval in milliseconds |
| `daemon.debounce_ms` | number | `1000` | Filesystem-event watch debounce in milliseconds |
| `daemon.auto_mount` | boolean | `true` | If true, the daemon auto-mounts ymesh extensions (MCP / skill / always-on) into detected CLIs on each reconcile. Set to `false` to require explicit `ymesh mount all`. |
| `daemon.device_id` | string | `os.hostname()` | Override the device identifier stored with each session |
| `daemon.skip_cass` | boolean | `false` | Skip the cass adapter (useful if its DB is absent) |
| `daemon.skip_claude` | boolean | `false` | Skip the Claude live watcher |
| `daemon.skip_codex` | boolean | `false` | Skip the Codex live watcher |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `YONDERMESH_HOME` | `~/.yondermesh` | Override the data directory (DB, PID file, releases, briefings, key). Read fresh on every CLI invocation, so it can be set per-shell. |
| `--db <path>` | `<data-dir>/yondermesh.db` | CLI flag (not an env var) — override the SQLite path for a single command. Useful for testing against a copy. |
| `--json` | off | CLI flag — emit JSON instead of human-readable output for script consumption. |

Example: running against a throwaway data dir.

```bash
YONDERMESH_HOME=/tmp/ymesh-test ymesh init
YONDERMESH_HOME=/tmp/ymesh-test ymesh daemon
```

Example: ad-hoc query against a copied DB.

```bash
ymesh sessions --db /tmp/snapshot.db --json | jq '.[] | .id'
```

## Related

- `/guide/daemon` — daemon lifecycle (scan -> watch -> reconcile -> idle)
- `/guide/sync` — relay protocol, key rotation, self-hosting
- `/reference/files` — runtime layout under `~/.yondermesh/`
- `/reference/cli` — every CLI flag and command
