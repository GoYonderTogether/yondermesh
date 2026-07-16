---
title: Troubleshooting
description: Diagnose and fix common yondermesh issues — daemon, MCP, sessions, sync, build, update, permissions, and Trae skill mounts.
outline: [2, 3]
---

# Troubleshooting

If something is broken, run `ymesh doctor` first. It checks the installation,
the local SQLite database, the daemon status, and recent logs in one pass and
usually points you at the failing layer.

```bash
ymesh doctor
```

For background facts (what yondermesh does and does not do), see
[FAQ](/guide/faq). For full command reference, see
[CLI Commands](/reference/cli).

## Daemon is not scanning sessions

**Symptoms**: `ymesh sessions` returns rows you do not expect, or new sessions
are not appearing in the local store.

**Fix**:

1. Check the daemon status:

   ```bash
   ymesh status
   ```

   If the daemon is not running, start it (`ymesh daemon` or
   `ymesh service start`).

2. Verify that `~/.yondermesh/config.yaml` has a `devices[].agents[].path`
   that actually matches where your CLI writes sessions. Common paths:

   ```yaml
   devices:
     - name: macbook
       agents:
         - type: claude-code
           path: ~/.claude/projects
         - type: codex
           path: ~/.codex/sessions
   ```

3. Run a scan manually to confirm the importer is finding files:

   ```bash
   ymesh scan
   ```

   If `ymesh scan` reports zero sessions for a given source, the path is
   wrong or the CLI has not written any sessions there yet.

## MCP tools are not appearing in my agent

**Symptoms**: The agent does not see `search_sessions`, `list_active_sessions`,
`get_session_handoff`, etc.

**Fix**:

1. Check the ymesh MCP registration status:

   ```bash
   ymesh mcp status
   ```

2. For Claude Code and Codex, registration is automated:

   ```bash
   ymesh mcp register
   ```

   This writes the MCP server block into `~/.claude/...` and
   `~/.codex/config.toml`.

3. For Cursor / Gemini / Windsurf, ymesh writes into their JSON config files
   (`~/.cursor/mcp.json`, `~/.gemini/settings.json`,
   `~/.windsurf/mcp_config.json`). Run `ymesh mount all` to apply.

4. **For Trae, MCP is configured via the IDE UI**, not a file. Open Trae's
   MCP settings and add a server with `command: ymesh`, `args: ["mcp"]`.

5. Restart the agent so it re-reads its config.

## `ymesh sessions` returns empty

**Symptoms**: `ymesh sessions` prints nothing, but you know sessions exist.

**Fix**:

1. Drop the filters and run a broad query:

   ```bash
   ymesh sessions --limit 50
   ```

2. Check whether your `--source` filter is correct. Canonical source IDs are
   lowercase (`claude`, `codex`, `cass`, `hermes`, …), not `ClaudeCode` or
   `claude-code`. The CLI normalizes aliases, but the value you pass must
   still resolve to a known source.

3. Check whether the session is a subagent. By default, queries return only
   `root` topology sessions. Try:

   ```bash
   ymesh sessions --topology subagent
   ```

4. Check the `--cwd-prefix` filter. It must be a parent directory of the
   session's `cwd`. Trailing slashes matter on some platforms.

5. Try including archived sessions (sessions that were deduped against
   another source):

   ```bash
   ymesh sessions --include-archived
   ```

6. Verify the database exists:

   ```bash
   ls -la ~/.yondermesh/yondermesh.db
   ```

   If it does not exist, run `ymesh scan` to build it.

## Cross-device sync is not working

**Symptoms**: Sessions from device A are not showing up on device B.

**Fix**:

1. Check `sync.relay_url` in `~/.yondermesh/config.yaml`:

   ```yaml
   sync:
     relay_url: https://relay.your-domain.com
     key_file: ~/.yondermesh/key.pem
   ```

2. Verify `~/.yondermesh/key.pem` exists on **both** devices. If a device is
   missing its key, sync cannot work — re-pair the device.

3. Verify the relay is reachable:

   ```bash
   curl -I https://relay.your-domain.com
   ```

4. Check the logs for sync errors:

   ```bash
   ls -la ~/.yondermesh/logs/
   ```

5. Force a sync cycle:

   ```bash
   ymesh state sync
   ```

See [Cross-device Sync](/guide/sync) for the full architecture.

## Build fails from source

**Symptoms**: `npm run build` errors out during clone, install, or compile.

**Fix**:

1. Ensure Node.js 18+ is installed:

   ```bash
   node --version
   ```

2. Install dependencies cleanly:

   ```bash
   rm -rf node_modules
   npm install
   ```

3. Re-run the build and capture the exact error:

   ```bash
   npm run build 2>&1 | tee build.log
   ```

4. Run the typecheck separately to isolate type errors from bundle errors:

   ```bash
   npm run typecheck
   ```

If the error is in a specific adapter, see
[CLI Adapters](/reference/adapters) for the adapter's source directory.

## `ymesh update` failed

**Symptoms**: `ymesh update` exits non-zero, or the new `ymesh` binary fails
to start.

**Fix**:

1. Roll back to the previous release immediately:

   ```bash
   ymesh rollback
   ```

2. Check the logs for the failed update:

   ```bash
   ls -la ~/.yondermesh/logs/
   ```

3. List installed releases to confirm the rollback landed:

   ```bash
   ymesh releases
   ```

4. If `ymesh update` was a `--local` build, make sure your working tree
   compiles cleanly (`npm run build`) before retrying.

## Permission errors

**Symptoms**: `ymesh` complains about unreadable files or unable-to-write
paths.

**Fix**:

1. Check ownership of the data directory:

   ```bash
   ls -la ~/.yondermesh/
   ```

   Every file should be owned by your user. If `sudo` ever touched this
   directory, fix it:

   ```bash
   sudo chown -R $(whoami) ~/.yondermesh
   ```

2. Check the launcher symlink:

   ```bash
   ls -la ~/.yondermesh/bin/ymesh
   ```

   It should point to `~/.yondermesh/releases/<current-version>/ymesh`. If
   the target is missing, reinstall with `ymesh install`.

3. Check the CLI's own config dir for stray permissions:

   ```bash
   ls -la ~/.claude/ ~/.codex/ ~/.cursor/
   ```

   The ymesh mount only writes into directories your user owns.

## Trae skills are not mounting

**Symptoms**: `~/.trae/skills/ymesh-*` symlinks are missing, or Trae does not
show ymesh skills in its skill list.

**Fix**:

1. Verify the target skill directories exist:

   ```bash
   ls -la ~/.trae/skills/
   ls -la ~/.trae-cn/skills/
   ```

   Create them if missing:

   ```bash
   mkdir -p ~/.trae/skills ~/.trae-cn/skills
   ```

2. Re-run the mount:

   ```bash
   ymesh mount all
   ymesh mount status
   ```

3. Trae covers four client variants (Trae IDE / Trae Work × international /
   CN) via just two `CliTarget`s (`~/.trae` and `~/.trae-cn`). If only one
   variant is missing skills, check the corresponding `~/.trae-cn/skills/`
   directory specifically.

4. **Trae does not support always-on paragraph injection or file-mounted
   MCP**. ymesh uses `skill-symlink` for Trae — make sure you are not
   expecting an `AGENTS.md` injection (it will not happen). For Trae MCP,
   configure it through the IDE UI.

See [Mount System](/guide/mount) for the full mount strategy table.

## Logs

All logs live under `~/.yondermesh/logs/`. The daemon writes a rolling log
file; the CLI appends to a separate file. Tail the daemon log to watch
scan/sync cycles in real time:

```bash
tail -f ~/.yondermesh/logs/daemon.log
```

## Database

The local SQLite database lives at `~/.yondermesh/yondermesh.db`. It is the
only persistent state on disk that cannot be rebuilt from the CLI's native
session files. If you suspect corruption:

```bash
sqlite3 ~/.yondermesh/yondermesh.db "PRAGMA integrity_check;"
```

## How to reset

To start over without losing your config or sync key:

```bash
ymesh service stop
mv ~/.yondermesh/yondermesh.db ~/.yondermesh/yondermesh.db.bak
ymesh scan
```

`ymesh scan` rebuilds the database from each CLI's native session files. The
sync key (`~/.yondermesh/key.pem`) and config are untouched, so cross-device
pairings survive the reset.

## Reporting bugs

If `ymesh doctor` and the steps above do not resolve the issue, open a bug
report at
[github.com/GoYonderTogether/yondermesh/issues](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=bug&template=bug_report.md).
Include:

- The output of `ymesh doctor`.
- The relevant log excerpt from `~/.yondermesh/logs/`.
- Your OS, Node.js version, and yondermesh version (`ymesh version`).
- The exact command you ran and the expected vs. actual behavior.

For security issues, follow the private disclosure process in
[SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md) —
do **not** open a public issue for security vulnerabilities.

## Related

- [FAQ](/guide/faq)
- [File Layout](/reference/files)
- [CLI Commands](/reference/cli)
- [Daemon](/guide/daemon)
- [Cross-device Sync](/guide/sync)
- [Mount System](/guide/mount)
