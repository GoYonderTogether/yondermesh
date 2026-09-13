---
title: CLI Commands
description: Complete reference for the ymesh CLI.
outline: [2, 3]
---

> **Auto-generated** from `ymesh help`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.
> yondermesh version: `0.1.0`

## Synopsis

```bash
ymesh <command> [options]
ymesh <command> --json          # JSON output for scripts
ymesh <command> --db <path>     # override DB path
```

## Commands

| Command | Description |
|---|---|
| `ymesh help` | Show this help |
| `ymesh version` | Show version |
| `ymesh scan` | Scan all local sessions (27 adapters: cass/claude/codex/hermes/ |
| `ymesh status` | Show daemon status and last scan result |
| `ymesh agents` | List detected agents and their support status |
| `ymesh sessions` | List sessions (supports filtering) |
| `ymesh daemon` | Start background daemon (live watch + periodic reconcile) |
| `ymesh Options:` | --db &lt;path&gt; --data-dir &lt;dir&gt; --pid-file &lt;path&gt; |
| `ymesh install` | Build a release locally and install it |
| `ymesh service` | &lt;action&gt;    LaunchAgent + menubar app (install|uninstall|start|stop|status) |
| `ymesh releases` | List installed release versions |
| `ymesh update` | [--local]    Update from Git source (auto-rollback on build failure); --local packs from local source |
| `ymesh rollback` | Roll back to the previous release manually |
| `ymesh mcp` | Start MCP server (stdio JSON-RPC, for other agents to mount) |
| `ymesh mcp` | call &lt;tool&gt; [args]  Call an MCP tool from the terminal (e.g. ymesh mcp call observe --scope active) |
| `ymesh mcp` | register        Register MCP server into Claude Code and Codex (auto-available in new sessions) |
| `ymesh mcp` | unregister      Unregister from Claude Code and Codex |
| `ymesh mcp` | status          Show MCP registration status |
| `ymesh active` | Quickly see which sessions are running now (who is working) |
| `ymesh waiting` | See sessions waiting for your review (agent has replied) |
| `ymesh doctor` | Run system diagnostics (install, database, daemon, log health) |
| `ymesh mount` | [status|all|remove]  Manage cross-CLI mounts (MCP/Skill/Plugin into every installed CLI agent) |
| `ymesh extract` | Extract a project's user requirements and assistant responses to NDJSONL (indexed by line/ID) |
| `ymesh handoff` | &lt;id&gt;        Extract a compacted handoff package (compacted summaries + tool calls + plan) for task takeover |
| `ymesh state` | &lt;action&gt;      Manage runtime state file (sync|show) |
| `ymesh observe` | See: inspect sessions across all local agents (scope=me|global|project|session|active|tree) |
| `ymesh message` | Say: talk to other agent sessions (action=send|check) |
| `ymesh orchestrate` | Manage: spawn / assign / handoff / await / discuss / stop (cooperative) / prior |
| `ymesh workspace` | Label: name and group working directories; see who is running where |
| `ymesh mailbox` | &lt;action&gt;    [legacy, use message] Cross-session message bus (post|get|pop|list|mark-read|check|whoami|unread) |
| `ymesh launch` | Start a new agent session (--cli &lt;agent&gt; --prompt "text" [--model &lt;m&gt;]) |
| `ymesh inject` | Inject a message into a running session (--cli &lt;agent&gt; --session &lt;id&gt; --message "text") |
| `ymesh transfer` | Transfer a session across agents (--cli &lt;src&gt; --session &lt;id&gt; --target &lt;dst&gt; [--output &lt;path&gt;]) |
| `ymesh send` | Sync injection v3: send a message to a target agent and get the reply synchronously (--cli &lt;agent&gt; [--session &lt;id&gt;] [--mode stopped|running|new] --message "text" [--model &lt;m&gt;] [--effort &lt;e&gt;] [--cwd &lt;path&gt;] [--timeout &lt;ms&gt;] [--json]) |
| `ymesh scaffold` | &lt;name&gt;     Generate a new adapter template (importer/wrapper/inject/index) into src/&lt;name&gt;/ |
| `ymesh Options:` | --config-dir &lt;dir&gt; --cli-binary &lt;bin&gt; |
| `ymesh --session-format` | jsonl|sqlite|json|markdown --yes (overwrite existing) |
| `ymesh sync` | fts            Explicitly backfill messages_fts full-text index in batches (use when large-DB auto-backfill is skipped) |
| `ymesh Options:` | --batch &lt;n&gt; (batch size, default 5000) [--json] |
| `ymesh compact` | Shrink the database: drop superseded revision bodies + rebuild the FTS index + return disk space |
| `ymesh Options:` | --dry-run (report only) --vacuum (return disk, needs exclusive access) |
| `ymesh --mode` | current-only|keep (revision body policy) [--json] |
| `ymesh retain` | analyze      Scan database for redundancy (noise/oversized/stale sessions + session-level classification), report compressible volume (read-only) |
| `ymesh retain` | apply        Execute retention (L0 drop noise + L2 truncate + SL0/SL1/SL2 session-level + L3 archive), with deduplicated backup |
| `ymesh Options:` | --dry-run (preview) --no-backup (skip backup) [--db &lt;path&gt;] [--json] |
| `ymesh reimport` | Re-scan a source to backfill structured tool_calls (idempotent; dry-run by default) |
| `ymesh Options:` | --source &lt;name&gt; [--limit &lt;n&gt;] [--dry-run] [--yes] [--db &lt;path&gt;] [--json] |

## Global Options

| Flag | Description |
|---|---|
| `--json` | Output as JSON (for script consumption) |
| `--db` | &lt;path&gt;         Database path (default ~/.yondermesh/yondermesh.db) |

## Filter Options

Used by `sessions`, `extract`, and `handoff`.

| Flag | Description |
|---|---|
| `--limit` | &lt;n&gt;         Limit output count (default 20) |
| `--source` | &lt;name&gt;     Filter by source (claude / codex / cass) |
| `--topology` | &lt;type&gt;   Filter by topology (root / subagent) |
| `--cwd` | &lt;path&gt;        Exact cwd match |
| `--cwd-prefix` | &lt;path&gt; cwd prefix match (directory-boundary safe) |
| `--project` | &lt;path&gt;    Exact projectPath match |
| `--from` | &lt;time&gt;       Start time (epoch ms or ISO date) |
| `--to` | &lt;time&gt;         End time (epoch ms or ISO date) |
| `--include-archived` | Include deduplicated sessions (hidden by default) |
| `--cwd-prefix` | &lt;path&gt;  Project dir prefix (default current cwd) |
| `--project` | &lt;path&gt;     Exact projectPath match (alternative to --cwd-prefix) |
| `--from` | / --to        Filter by session start-time range |
| `--requirements` | Query requirements file (user messages) |
| `--responses` | Query responses file (assistant messages) |
| `--id` | &lt;n&gt;             Take one entry by line/ID (1-based) |
| `--keyword` | &lt;text&gt;     Fuzzy keyword match (case-insensitive) |
| `--session` | &lt;id&gt;       Filter by yondermesh session ID |
| `--limit` | &lt;n&gt;          Max query results |
| `--offset` | &lt;n&gt;         Skip first N results |
| `--list` | List all extracted projects |
| `--json` | Output the handoff package as JSON |
| `--tail` | &lt;n&gt;          Number of tail messages (default 30) |

## Examples

```bash
ymesh scan
ymesh sessions --limit 50
ymesh sessions --source claude --topology root
ymesh sessions --cwd-prefix /Users/zoran/projects --json
ymesh status
ymesh daemon
ymesh extract --cwd-prefix /Users/zoran/projects/yondermesh
ymesh extract --requirements --id 3
ymesh handoff 019f5fe4-b127-7de2-b8f1-efa45bee24cb
ymesh handoff 019f5fe4-b127-7de2-b8f1-efa45bee24cb --json --tail 50
ymesh scaffold mycli --yes
```
