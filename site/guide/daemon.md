---
title: Daemon
description: The yondermesh daemon harvests sessions from CLI native files via a scan / watch / reconcile loop. Learn to start it, run it as a service, and diagnose it.
outline: [2, 3]
---

# Daemon

The yondermesh daemon is the background process that keeps your local SQLite store in sync with what your CLI agents are writing. It reads native files only — it never modifies them.

## What the daemon does

The daemon runs a scan-once + watch + reconcile loop (implemented in `src/daemon/index.ts`, class `YondermeshDaemon`):

```text
start → scan-once → watch (fs events) → periodic reconcile → idle
```

- **scan-once** — on start, every registered importer runs once. `cass` is scanned only once per daemon lifetime (it is not a live data source); `claude` and `codex` are scanned on every reconcile pass too.
- **watch** — `fs.watch` (recursive on macOS) listens on the Claude and Codex session directories. File-change events are debounced (`debounceMs`, default 1s) before triggering an incremental scan of the affected source. On detecting a newly-inserted session, the daemon prints a single stderr line.
- **periodic reconcile** — `setInterval` runs `fullScan()` every `reconcileIntervalMs` (default 60s). This is the safety net for CLIs that have no watchable session directory (Cursor, Gemini, Windsurf, Trae store sessions internally) and for any fs.watch miss. If `autoMount` is on (default), reconcile also re-applies mounts idempotently.

The daemon holds a single-instance lock via a PID file. If a live daemon is already running, `start()` throws instead of double-scanning.

The daemon never modifies native CLI files. It only reads them through each adapter's importer. See [Architecture](/guide/architecture) for the invariant this enforces.

## Starting the daemon

Run the daemon in the foreground with `ymesh daemon`:

```bash
ymesh daemon
```

The process stays attached to your terminal. Stop it with `Ctrl+C` (SIGINT) or `kill <pid>` (SIGTERM) — both trigger a graceful `stop()` that clears debounce timers, closes all `fs.FSWatcher` handles, clears the reconcile interval, releases the PID lock, and closes the SQLite store.

If the daemon crashes or is killed without releasing the PID file, the next `start()` detects that the stored PID is no longer alive (via `process.kill(pid, 0)` probe) and reclaims the lock.

## Running as a service

For always-on operation, install the daemon as a system service:

```bash
# Install as a LaunchAgent (macOS)
ymesh service install

# Manage the service
ymesh service start
ymesh service stop
ymesh service status

# Remove the service
ymesh service uninstall
```

On macOS, `ymesh service install` registers a LaunchAgent that starts the daemon on login and restarts it on crash. `ymesh service status` reports whether the agent is loaded and the daemon process is alive.

## Daemon config

The daemon reads its configuration from defaults defined in `src/daemon/config.ts`, overridable through the `DaemonConfig` interface:

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `~/.yondermesh` (or `$YONDERMESH_HOME`) | Data directory for DB, PID file, etc. |
| `dbPath` | `<dataDir>/yondermesh.db` | SQLite database file. |
| `pidFile` | `<dataDir>/daemon.pid` | Single-instance lock file. |
| `reconcileIntervalMs` | `60000` (1 minute) | Periodic full-scan interval. |
| `debounceMs` | `1000` (1 second) | Watch-event debounce delay. |
| `deviceId` | `os.hostname()` | Device identifier written into sessions. |
| `autoMount` | `true` | Re-apply mounts after reconcile and on new-session detection. |
| `skipCass` / `skipClaude` / `skipCodex` | `false` | Per-source skip flags. |

### Overriding the data directory

Set the `YONDERMESH_HOME` environment variable to relocate the entire data directory (DB, PID file, config, logs, briefings):

```bash
export YONDERMESH_HOME=/var/lib/yondermesh
ymesh daemon
```

`defaultDataDir()` in `src/daemon/config.ts` resolves to `$YONDERMESH_HOME` when set, falling back to `~/.yondermesh`.

The user-facing config file is `~/.yondermesh/config.yaml` (see [Configuration](/reference/config) for the full schema).

## Periodic reconcile interval

The reconcile interval (`reconcileIntervalMs`) is the cadence at which the daemon re-runs `fullScan()` even when no fs.watch events have fired. The default of 60 seconds is a balance between freshness and cost.

Tune it if your workflow demands it:

- **Shorter** (e.g. 15s) — faster pickup of sessions from CLIs without watchable directories (Cursor, Gemini, Windsurf, Trae), at the cost of more scans.
- **Longer** (e.g. 5min) — lower background CPU, at the cost of slower visibility for non-watchable CLIs.

For CLIs with watchable directories (Claude Code, Codex), updates are picked up near-instantly via fs.watch regardless of the reconcile interval — reconcile is only the fallback.

## Checking daemon status

`ymesh status` reports whether the daemon is running, its PID, the data directory, watched paths, the last scan result, and any watch errors:

```bash
ymesh status
```

The status snapshot (type `DaemonStatus` in `src/daemon/index.ts`) is read from the PID file and the persisted `watched-paths.json` file — the CLI and the daemon are separate processes, so the daemon writes its watched-paths list to disk on start and clears it on stop.

If no daemon is running, `ymesh status` will say so and exit non-zero.

## Doctor diagnostics

`ymesh doctor` runs a full health check across installation, database, daemon, and logs:

```bash
ymesh doctor
```

It checks:

- **Installation** — the `ymesh` binary resolves, the release symlink is intact, the current release is not corrupt.
- **Database** — `yondermesh.db` is readable, the schema is present, row counts are sane.
- **Daemon** — the PID file exists, the stored PID is alive, the last scan finished without error.
- **Logs** — recent log lines exist and contain no unexpected error patterns.

Use `ymesh doctor` as the first step when something feels off — it pinpoints which layer is broken.

## Logs and rotation

The daemon writes single-line progress messages to stderr (e.g. `[yondermesh] 新 session 检测到: claude <id>`). When run in the foreground, these go to your terminal. When run as a LaunchAgent, macOS captures them in `~/Library/Logs/yondermesh/`.

There is no built-in log rotation — the LaunchAgent plist relies on macOS' standard log rotation for LaunchAgent stderr/stdout captures. If you run the daemon under a process manager (launchd, systemd, supervisord), configure rotation at that layer.

## Related

- [Cross-device Sync](/guide/sync) — the sync agent that piggybacks on the daemon's store.
- [Sessions & Topology](/guide/sessions) — what the daemon harvests into.
- [File Layout](/reference/files) — the canonical map of `src/daemon/` files.
- [Architecture](/guide/architecture) — the daemon lifecycle in the context of the three planes.
