---
title: Architecture
description: yondermesh's bird's-eye view — three planes, the daemon lifecycle, module layout, and the invariants that hold the system together.
outline: [2, 3]
---

# Architecture

yondermesh is a self-hosted **Agent Context Bus**: one daemon plus one MCP server that let your AI coding agents share a single working surface across devices and CLIs. Sessions are harvested from each CLI's native format into local SQLite; an MCP server exposes query and handoff tools to any MCP-capable agent; cross-device sync moves ciphertext only over a self-hosted relay.

## Overview

yondermesh operates on **three planes that never cross-contaminate**. Keeping these planes separate is the single most important design decision in the codebase — it is what makes the system non-invasive.

```text
Local plane        CLI native files → adapter → SessionStore (SQLite) → MCP server (stdio)
Sync plane         SessionStore → relay agent → self-hosted relay (ciphertext only) → peer device
Mount plane        ymesh skills / MCP config → CLI's own config dir (~/.claude/, ~/.codex/, ~/.cursor/, …)
```

- The **Local plane** reads what each CLI wrote and turns it into structured queries. Adapters are pure readers; they never modify native files.
- The **Sync plane** ships context between your own devices. Ciphertext only leaves the device — the relay never sees plaintext.
- The **Mount plane** installs ymesh extensions (MCP server config, skill symlinks, always-on paragraphs) into each CLI's own config directory. It edits config files, never binaries.

The CLI itself (`ymesh`) is a thin wrapper over the same `SessionStore` that the daemon writes to. `ymesh scan`, `ymesh sessions`, `ymesh active` are direct store queries — there is no separate daemon protocol for read-only commands.

## Architecture diagram

```text
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

Each device runs its own daemon. Devices pair through a self-hosted relay that carries ciphertext only. No cloud sees plaintext; no relay is a trusted party.

## Core mental model

The unit of context in yondermesh is a **session**. An agent's session is what gets harvested, queried, synced, and handed off. Every MCP tool is a structured query over the session graph; every adapter is a reader of one CLI's native session format.

A session carries three orthogonal identity axes:

- **source** — which CLI produced it, normalized to a canonical ID (`claude`, `codex`, `cass`, `hermes`, `continue`, `windsurf`, …). Raw names like `claude-code` or `ClaudeCode` are folded to `claude` by `src/store/source-aliases.ts`.
- **topology** — the session's role in the agent's call tree: `root`, `subagent`, or `sidechain`.
- **project** — `cwd` and `projectPath`, so queries can scope to a working directory or a project root.

On top of these, every session has two orthogonal status axes:

- **presence** — `present` / `missing` / `unknown` (whether the native file still exists on disk).
- **retention** — `live` / `archived` / `purged` (whether the session is still active, deduplicated away, or purged).

The canonical identity triple that uniquely keys a session is `device_id + source_instance_id + native_session_id` — never just the CLI name and session id. See the [Sessions & Topology](/guide/sessions) page for the full attribute list.

## Daemon lifecycle

The daemon runs the following loop (defined in `src/daemon/index.ts`, class `YondermeshDaemon`):

```text
start → scan-once → watch (fs events) → periodic reconcile → idle
```

1. **start** — `acquireLock()` writes a PID file to enforce single-instance. If a live daemon is already running, `start()` throws.
2. **scan-once** — `fullScan()` runs every registered importer once. `cass` is scanned only once per daemon lifetime (it is not a live data source); `claude` and `codex` are scanned on every reconcile.
3. **watch** — `fs.watch` (recursive on macOS) listens on the Claude and Codex session directories. File change events are debounced (`debounceMs`, default 1s) before triggering an incremental scan of the affected source.
4. **periodic reconcile** — `setInterval` runs `fullScan()` every `reconcileIntervalMs` (default 60s). This is the safety net for CLIs that have no watchable session directory (Cursor, Gemini, Windsurf, Trae store sessions internally) and for any fs.watch miss.
5. **idle** — between scans the daemon holds the lock and keeps watchers alive. `SIGINT` / `SIGTERM` trigger `stop()`.

`stop()` is graceful: it clears debounce timers, closes all `fs.FSWatcher` handles, clears the reconcile interval, releases the PID lock, and closes the SQLite store. See [Daemon](/guide/daemon) for operational detail.

## Module layout

The source tree under `src/` is organized by responsibility. The table below is a summary; the canonical, always-up-to-date file map lives in [`ARCHITECTURE.md`](https://github.com/GoYonderTogether/yondermesh/blob/main/ARCHITECTURE.md) and the [File Layout](/reference/files) reference.

| Directory | Role |
|---|---|
| `src/bin/` | CLI entry point (`ymesh.ts`). Pure hand-rolled `parseArgs`, no CLI framework. Command dispatch via a `main()` switch. |
| `src/` (per-adapter) | One directory per supported CLI (`aider`, `claude`, `codex`, `cass`, `gemini`, `windsurf`, …). Each adapter follows the `importer.ts` / `wrapper.ts` / `inject.ts` / `extractor.ts` file pattern. |
| `src/store/` | The only writer/reader of SQLite. `SessionStore` class, schema, types, source aliases, dedup logic. |
| `src/daemon/` | `YondermeshDaemon` lifecycle + `defaultDaemonConfig` / `defaultDataDir`. |
| `src/mcp/` | `McpServer` (stdio JSON-RPC) + registration into Claude Code and Codex + handoff package builder. |
| `src/mount/` | Mount system: installs ymesh extensions into each CLI's config dir without modifying the CLI. |
| `src/install/` | Release build, launcher symlink, git updater, skill linker, path resolution. |
| `src/extract/` | `ymesh extract` — dumps user requirements + assistant responses to NDJSONL files. |
| `src/briefing/` | Daily digest generator (output to `~/.yondermesh/briefings/`). |
| `src/sync/` | Cross-device sync agent (ciphertext only). |

A few cross-cutting rules keep the boundaries clean:

- `src/store/` is the only writer to SQLite. Adapters call `SessionStore` methods; they never write SQL directly.
- `src/bin/ymesh.ts` is the only place commands are registered. Adding a command means adding a `case` to `main()` plus a `cmd*` function.
- `src/mount/` never imports from `src/<adapter>/`. Mount strategies are driven by CLI config, not by adapter code.
- `scripts/docs/` never imports from `src/`. It shells out to `ymesh help` and reads `src/*/` as plain files, keeping the docs generator decoupled from internal refactors.

## Architectural invariants

These invariants are enforced by code structure and CI (`scripts/docs/check-drift.mjs`, `scripts/docs/verify-links.mjs`). Breaking one is a bug.

1. **No CLI modification.** Adapters read native files; mounts write into the CLI's own config dir but never patch the CLI binary or its session writer.
2. **No model proxy.** yondermesh never touches API keys. The CLI runs the model; ymesh only reads what the CLI wrote.
3. **No cloud lock-in.** The sync relay is self-hostable. A cloud relay is optional convenience and never sees plaintext.
4. **No UI.** Config-file driven; the daemon runs headless. This docs site is for humans reading about yondermesh, not for operating it.
5. **Topology-aware.** Every session has a topology (`root` / `subagent` / `sidechain`). Queries that don't explicitly ask for subagents return roots only by default.
6. **Source-canonical.** Every session has a canonical source ID (`claude`, not `ClaudeCode` or `claude-code`). `src/store/source-aliases.ts` normalizes on write and expands on query.
7. **Doc lag = bug.** A code change ships with its doc change in the same commit. `check-drift.mjs` and `verify-links.mjs` enforce this in CI.

The CLI being a thin wrapper over `SessionStore` is a corollary of invariants 1 and 4: there is no daemon RPC for read commands, because the store is the only state and it is local SQLite.

## Related

- [Sessions & Topology](/guide/sessions) — the session data model, attribute list, and query surface.
- [Daemon](/guide/daemon) — operating the daemon: foreground run, service install, status, doctor.
- [Cross-device Sync](/guide/sync) — the sync agent, relay setup, and the ciphertext-only invariant.
- [File Layout](/reference/files) — the canonical, always-up-to-date map of every file under `src/`.
- [CLI Commands](/reference/cli) — the full `ymesh` command surface.
