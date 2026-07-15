---
title: What is yondermesh?
description: A self-hosted Agent Context Bus that lets your AI coding agents share context, query each other, and hand off tasks across devices and CLIs.
outline: [2, 3]
---

# What is yondermesh?

yondermesh is a self-hosted **Agent Context Bus**. It runs one daemon per device
that harvests sessions from every CLI coding agent into a local SQLite store, and
exposes one MCP (Model Context Protocol) server that any MCP-capable agent can
query. The result: your agents stop being islands and start sharing a single
working surface across devices and CLIs.

## The problem: agents are islands

If you use multiple AI coding agents — Claude Code, Codex, Aider, Gemini CLI,
Cursor, Windsurf, Trae, Continue, OpenCode — across multiple machines, you
already know the pain points:

- **Context dies at the session boundary.** When a session ends, everything the
  agent learned vanishes. The next session, or a different agent on a different
  device, starts from scratch.
- **Agents cannot see each other.** Your Codex session on the laptop has no idea
  what your Claude Code session on the desktop just did. There is no shared
  working surface.
- **Handoffs are manual.** To pass work from one agent to another, you copy-paste
  summaries, re-explain the project, and hope nothing important gets lost.
- **No cross-device visibility.** You cannot ask "what did my agents do today?"
  without ssh-ing into each machine and reading each CLI's native logs in their
  own format.

Every CLI writes sessions in its own format — JSONL, session databases, git logs,
transcript hooks. Every device is isolated. The result is fragmented, lossy, and
impossible to query as a whole.

## The solution: one daemon, one MCP server, zero intrusion

yondermesh fixes this with a deliberately small surface:

- **One daemon** — `ymesh daemon` runs headless, watches native session files, and
  writes to `~/.yondermesh/yondermesh.db`. It reads native files only and never
  modifies the CLIs it reads from.
- **One MCP server** — `ymesh mcp` speaks stdio JSON-RPC. Any CLI that supports MCP
  (Claude Code, Codex, Cursor, Gemini, Windsurf, and others) can call the same
  tools without per-CLI glue code.
- **Zero intrusion** — no UI, no cloud lock-in, no model proxy, no agent
  modification. yondermesh reads what the CLI already wrote and exposes it
  through MCP. That is the entire surface.

Three planes that never cross-contaminate:

```
Local plane    CLI native files -> adapter -> SessionStore (SQLite) -> MCP server (stdio)
Sync plane     SessionStore -> relay agent -> self-hosted relay (ciphertext only) -> peer device
Mount plane    ymesh skills / MCP config -> CLI's own config dir (~/.claude/, ~/.codex/, ...)
```

## Core capabilities

### Collect

Auto-harvest sessions from every CLI agent on every device into local SQLite.
yondermesh ships with adapters that read each CLI's native format directly —
Claude Code JSONL, Codex session DBs, Aider git log, Continue sessions, and many
more. No CLI modification is needed; the daemon reads files the CLI already
writes.

Each adapter has a coverage level:

- **A** — Native importer: reads the CLI's native session files (JSONL / session
  DB) directly into the store.
- **B** — Wrapper / markdown importer: parses exported markdown, git log, or
  wrapper output.
- **C** — Extractor only: partial coverage, for example a live transcript hook.

The daemon lifecycle is simple: `start -> scan-once -> watch (fs events) ->
periodic reconcile -> idle`. It reads native files only and never modifies them.
See the [CLI Adapters reference](/reference/adapters) for the full support matrix.

### Sync

Cross-device sync via a self-hosted relay. Sessions are encrypted end-to-end with
a local key before they ever leave the device — the relay only sees ciphertext.
Cloud relay is optional convenience; you can self-host the relay and never let
plaintext leave your machines.

The sync agent reads new sessions from the local `SessionStore`, encrypts them
with the local key, pushes ciphertext to the relay, and pulls peer updates to
decrypt locally. The relay is a dumb pipe: it never holds a decryption key.

### Query

Any MCP-capable agent queries any other agent's context through a small set of
MCP tools:

- `recall_recent_work` — query recent sessions across the entire mesh.
- `whats_on_device` — inspect a remote device's project state.
- `who_is_working` — see which agents are currently active.
- `list_active_sessions` — enumerate live sessions.
- `search_sessions` — full-text search over harvested sessions.
- `handoff_task` — delegate a task to another agent.

Because the store is [topology-aware](/guide/sessions) (root / subagent /
sidechain), source-aware (`claude`, `codex`, `cass`, `hermes`, `continue`,
`windsurf`, ...), and project-aware (`cwd`, `projectPath`), queries return
structured results, not raw logs. Queries that do not explicitly ask for
subagents return roots only by default.

### Hand off

Agent A picks up where agent B left off, even on a different machine. The
`ymesh handoff <session-id>` command builds a compacted `HandoffPackage` —
summary plus recent tool calls plus task plan — that can be fed into another
agent's context window. This is the bridge that turns isolated sessions into a
continuous workflow across devices.

The same mechanism powers the `handoff_task` MCP tool, so an agent can request a
handoff package programmatically without a human in the loop.

## What it doesn't do

yondermesh is deliberately narrow. The following are non-goals by design, not
current limitations:

- **No UI.** Configuration is file-driven; the daemon runs headless. This
  documentation site is for humans reading about yondermesh, not for operating it
  day to day.
- **No cloud lock-in.** Fully self-hostable. The sync relay is self-hostable; the
  official cloud relay is optional convenience and never sees plaintext.
- **No model proxy.** yondermesh never touches your API keys. The CLI runs the
  model; yondermesh only reads what the CLI wrote.
- **No agent modification.** Adapters read native files; mounts write into each
  CLI's own config directory but never patch the CLI binary or its session
  writer.

These boundaries are [architectural invariants](/guide/architecture), enforced by
module boundaries in the source tree, not just aspirational guidelines.

## A note on the mount system

yondermesh extends its reach into other CLIs through a non-invasive **mount
system**. Each mount installs a yondermesh extension (MCP server / skill /
always-on paragraph) into a CLI's own config directory — for example
`~/.claude/claude_desktop_config.json`, `~/.codex/config.toml`,
`~/.cursor/mcp.json`, or `~/.gemini/settings.json`.

The mount system never imports from individual adapters. Mount strategies are
driven by CLI config locations, not by adapter internals, which keeps the two
concerns cleanly separated. See the [Mount System guide](/guide/mount) for
details.

## Where to go next

- [Quickstart](/guide/quickstart) — install yondermesh and run your first scan in
  under five minutes.
- [Installation](/guide/installation) — npm install, build from source, release
  management, and the macOS LaunchAgent service.
- [Architecture](/guide/architecture) — the three planes (local / sync / mount),
  the codemap, and the invariants that keep them clean.
- [CLI Commands](/reference/cli) — the full command reference, auto-generated
  from `ymesh help`.
- [CLI Adapters](/reference/adapters) — the support matrix for every CLI agent
  yondermesh can harvest sessions from.
