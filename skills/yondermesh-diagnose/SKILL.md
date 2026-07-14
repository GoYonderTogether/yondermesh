---
name: yondermesh-diagnose
description: >-
  Diagnose and troubleshoot yondermesh runtime issues on a live installed system.
  Use when: the user says "check yondermesh", "yondermesh has a problem", "why is yondermesh not working",
  "what's wrong with my sessions", "daemon not running", "database looks wrong",
  "sessions not syncing", or any question about yondermesh system health, data integrity,
  daemon status, log errors, or adapter coverage. Also use when an agent encounters unexpected
  yondermesh behavior and needs to self-diagnose before escalating to the user.
  Works for both maintainers (with source access) and end users (installed binary only).
---

# yondermesh Diagnostics

This skill diagnoses a running yondermesh installation. It is NOT a test suite —
it inspects live system state: database, daemon, logs, adapters, and CLI health.

## Quick Start

Run the diagnostic script for a full system snapshot:

```bash
bash <skill-dir>/scripts/diagnose.sh
```

For a specific section: `--section install|db|daemon|logs|cli|adapters`

For verbose output with full details: `--verbose`

The script exits non-zero if any FAIL-level issues are found. Use the exit code
and the SUMMARY section to determine severity.

## Diagnostic Procedure

1. Run the full diagnostic to get a baseline. Note every FAIL and WARN.
2. Classify the problem by matching symptoms to sections:
   - Installation/symlink issues -> check install section
   - No data / wrong data -> check db and adapters sections
   - Daemon not running / crashed -> check daemon and logs sections
   - CLI command fails -> check cli section
3. Cross-reference with healthy state.
   Read references/healthy-state.md and compare actual values against expected.
4. Look up known issues.
   Read references/known-issues.md and match the symptom to a decision tree.
5. Inspect logs directly if the issue is not in known issues:
   ```bash
   grep -ri 'error\|fail\|crash' ~/.local/state/yondermesh/ 2>/dev/null | tail -20
   ```
6. Query the database directly for data-level issues:
   ```bash
   sqlite3 ~/.yondermesh/yondermesh.db "SELECT cli_name, count(*) FROM source_instances si JOIN sessions s ON s.source_instance_id=si.id GROUP BY cli_name;"
   ```
7. Propose a fix based on findings. If the fix is safe and within scope, implement it.
   If not, report findings to the user with a clear recommendation.

## Path Resolution

yondermesh respects YONDERMESH_HOME for all paths. Default is ~/.yondermesh/.

Key paths:
- Data dir: $YONDERMESH_HOME (default ~/.yondermesh/)
- Database: $YONDERMESH_HOME/yondermesh.db
- PID file: $YONDERMESH_HOME/daemon.pid
- Releases: $YONDERMESH_HOME/releases/
- Current symlink: $YONDERMESH_HOME/releases/current
- Logs: ~/.local/state/yondermesh/ or $YONDERMESH_HOME/logs/
- LaunchAgent: ~/Library/LaunchAgents/com.yondermesh.daemon.plist

If YONDERMESH_HOME is set, use that instead of ~/.yondermesh/ everywhere.

## What Not to Do

- Do NOT delete the database file unless the user explicitly asks.
- Do NOT kill the daemon process unless diagnosing a crash loop.
- Do NOT modify LaunchAgent plist without understanding the current state.
- Do NOT run ymesh update as a diagnostic step.
- Do NOT assume source code access for end users.

## When to Escalate

Escalate to the user when:
- Database corruption is detected and cannot be self-repaired.
- The fix requires GitHub credentials or network access you don't have.
- The fix requires modifying files outside yondermesh directories.
- The same error recurs after applying a known fix.

## For Community Users

If helping a community user (not the maintainer):
1. Run diagnostics to collect evidence.
2. Check known-issues.md for matching solutions.
3. If unresolved, help the user file an issue with diagnostic output attached.

## Cross-CLI Usage

This skill auto-installs for Codex (via ~/.codex/skills/ symlink). For other CLIs:

- Any agent can run the diagnostic script directly:
  `bash ~/.yondermesh/releases/current/skills/yondermesh-diagnose/scripts/diagnose.sh`
- Or use the CLI: `ymesh doctor`
- The script is bash-only, no Node.js or npm required for diagnostics.

## Distribution

Skills are bundled into each release. The install command links them to CLI skill
directories. When `ymesh update` switches the current release, skill symlinks
automatically follow the new version. Developers push skill changes to git; users
get them via `ymesh update`.
