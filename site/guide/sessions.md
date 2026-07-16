---
title: Sessions & Topology
description: The session is the unit of context in yondermesh. Learn its attributes, topology types, source aliases, and how to query and hand off sessions.
outline: [2, 3]
---

# Sessions & Topology

The session is the unit of context in yondermesh. Everything the system does — harvest, query, sync, hand off — operates on sessions. This page describes what a session is, the attributes it carries, and the CLI surface for querying them.

## What is a session

A session is one run of one CLI agent: a Claude Code conversation, a Codex session, an Aider git-log run, etc. Each session is **harvested from the CLI's native format** by an adapter (a reader of JSONL, a session DB, a git log, …) and **upserted into local SQLite** via `SessionStore`.

The canonical identity triple that keys a session is:

```text
device_id + source_instance_id + native_session_id
```

`source_instance_id` identifies one collection entry on a device (for example, the `~/.claude/projects` directory of a Claude Code install). This triple is what makes a session unique — never the CLI name plus session id alone, because the same native session id can appear under different source instances or devices.

The SQLite schema (see `src/store/schema.ts`) stores sessions in the `sessions` table, with message history in `session_revisions` and `messages`, relationships in `session_relationships`, and scan bookkeeping in `scan_runs`. `src/store/` is the only writer; adapters never touch SQL directly.

## Session attributes

Every `SessionRecord` (defined in `src/store/types.ts`) carries:

| Attribute | Type | Meaning |
|---|---|---|
| `id` | `string` | yondermesh session id (UUID). |
| `deviceId` | `string` | Device the session was harvested on. |
| `sourceInstanceId` | `string` | The collection entry that produced it. |
| `nativeSessionId` | `string` | The CLI's own session id (e.g. a Claude JSONL UUID). |
| `source` | `string` | Canonical source id (`claude`, `codex`, …). |
| `cwd` | `string \| null` | Working directory the CLI was invoked in. |
| `projectPath` | `string \| null` | Project root, if distinguishable from `cwd`. |
| `topology` | `SessionTopology` | `root` / `subagent` / `sidechain` (see below). |
| `presence` | `Presence` | `present` / `missing` / `unknown`. |
| `retention` | `Retention` | `live` / `archived` / `purged`. |
| `contentHash` | `string` | Hash of the current revision's content. |
| `currentRevisionId` | `number \| null` | Pointer into `session_revisions`. |
| `messageCount` | `number` | Messages in the current revision. |
| `startedAt` | `number \| null` | Epoch ms when the session started. |
| `lastSeenAt` | `number` | Epoch ms of the most recent scan that touched it. |
| `model` | `string \| null` | Model name, if the CLI exposed it. |
| `cliVersion` | `string \| null` | CLI version string. |
| `estimatedCostUsd` | `number \| null` | Estimated spend, if available. |
| `totalInputTokens` / `totalOutputTokens` / `toolCallCount` | `number \| null` | Token and tool-call accounting. |

`presence` and `retention` are orthogonal status axes — they are not derived from each other. A session can be `present` + `archived` (the native file still exists but the session was deduplicated away from a cross-source duplicate).

## Topology types

Every session has a `topology` (type `SessionTopology` in `src/store/types.ts`):

- **`root`** — a top-level agent session. This is the default. Queries that don't explicitly ask for subagents return roots only, so `ymesh sessions` shows you the conversations you actually had, not the internal sub-agent calls.
- **`subagent`** — a session spawned by another session (e.g. Claude Code's Task tool spawning a sub-agent). Relationships are tracked in `session_relationships` with `relation_type = 'spawned_by'`.
- **`sidechain`** — a session that runs alongside a root session but is not strictly spawned by it (e.g. a side conversation, a parallel exploration). Tracked with `relation_type = 'sidechain_of'`.

The full set of `RelationType` values is: `spawned_by`, `sidechain_of`, `continued_from`, `import_alias_of`, `derived_from`. Relationships are modeled in their own table, not crammed into a `parent_id` column — this lets one session have multiple typed relationships without schema gymnastics.

## Source aliases

Raw source names are messy. Claude Code writes `claude-code` in some places and `ClaudeCode` in others; cass reads `claude_code` from its database. yondermesh normalizes all of these to a single canonical id on write, and expands the canonical id back to all known aliases on query — so `--source claude` finds every spelling.

The mapping lives in `src/store/source-aliases.ts`. A few representative entries:

| Raw alias | Canonical |
|---|---|
| `claude`, `claude-code`, `claude_code`, `claudecode` | `claude` |
| `codex` | `codex` |
| `opencode`, `open-code`, `open_code` | `opencode` |
| `gemini`, `gemini-cli`, `gemini_cli` | `gemini` |
| `continue`, `cn`, `continue-cli`, `continuedev` | `continue` |
| `cline`, `cline-cli`, `clinecli` | `cline` |
| `trae-cli`, `trae_cli`, `traecli` | `trae_cli` (distinct from Trae IDE's `trae`) |
| `factory`, `factory-droid`, `droid` | `factory` |

Two functions do the work:

- `normalizeSource(raw)` — called on import; returns the canonical id. Unknown sources pass through unchanged so no information is lost.
- `expandSource(canonical)` — called on query; returns every alias that maps to the canonical id, so a SQL `IN (...)` clause matches all spellings.

Unknown source names are not discarded — they pass through as-is, which means legacy data with non-canonical names still queryable until the next scan normalizes it.

## Querying sessions

`ymesh sessions` lists sessions with filters. All filters are optional and combine with AND semantics.

```bash
# Latest 20 sessions across all sources
ymesh sessions

# Filter by source (canonical name; aliases auto-expanded)
ymesh sessions --source claude

# Filter by topology (default: root only)
ymesh sessions --topology subagent

# Filter by working directory
ymesh sessions --cwd /Users/zoran/projects/foo
ymesh sessions --cwd-prefix /Users/zoran/projects

# Filter by project path
ymesh sessions --project /Users/zoran/projects/foo

# Time window (epoch ms or ISO 8601)
ymesh sessions --from 2025-01-01 --to 2025-02-01

# Include sessions deduplicated away by cross-source dedup
ymesh sessions --include-archived

# Machine-readable output
ymesh sessions --source codex --json
```

The full filter set (from `src/store/types.ts`, `SessionQuery`):

| Flag | Maps to | Behavior |
|---|---|---|
| `--source` | `source` | Canonical source; aliases auto-expanded via `expandSource`. |
| `--topology` | `topology` | `root` / `subagent` / `sidechain`. |
| `--cwd` | `cwd` | Exact match on working directory. |
| `--cwd-prefix` | `cwdPrefix` | Prefix match with directory-boundary safety (LIKE special chars escaped). |
| `--project` | `projectPath` | Exact match on project path. |
| `--from` | `startedAtFrom` | Inclusive lower bound on `startedAt`. |
| `--to` | `startedAtTo` | Inclusive upper bound on `startedAt`. |
| `--limit` | `limit` | Cap on results (default 20). |
| `--include-archived` | `includeArchived` | Include sessions with `retention = 'archived'`. Default false. |

Queries return `retention = 'live'` sessions by default. To see sessions that cross-source dedup has marked as `archived`, pass `--include-archived`.

## Active sessions

`ymesh active` answers "who is working right now?". It returns sessions whose `lastSeenAt` falls within the active window (recent scan activity), with a `isLive` flag for sessions being written to within the live threshold.

```bash
ymesh active
```

The output is the `ActiveSummary` shape from `src/store/types.ts`: a count of active sessions, a count of live (currently-writing) sessions, breakdowns by source, and a per-session list ordered by `lastSeenAt` descending. This is the same data that powers the MCP tool `who_is_working`.

## Cross-source deduplication

The same physical session can be harvested by two different importers — most commonly, cass (the B-level compatibility importer that reads from the cass database) and a native A-level adapter (e.g. the Claude Code JSONL importer) both see the same Claude session. Without dedup, you'd see it twice.

`SessionStore.deduplicateCrossSource` collapses these. The match key is `normalized_source + canonical_id`, where `canonical_id` is the UUID extracted from `native_session_id` (see `extractCanonicalId` in `src/store/source-aliases.ts`). When two sessions share a match key, the higher-coverage one (A beats B) is kept `live`; the other is marked `retention = 'archived'`. Archived sessions are excluded from default queries — pass `--include-archived` to see them.

## Extract and handoff

Two commands turn sessions into portable artifacts:

- **`ymesh extract`** dumps every user requirement and assistant response for a project to NDJSONL files (one per kind), indexed by line number and session id. Powers corpus export and offline analysis. See `src/extract/`.
- **`ymesh handoff <id>`** builds a `HandoffPackage` — compacted summaries plus recent messages plus a task plan — for a single session, so agent B can pick up where agent A left off. The same builder backs the `get_session_handoff` MCP tool. See `src/mcp/codex-handoff.ts`.

Both commands accept the shared filter flags (`--source`, `--cwd-prefix`, `--project`, `--from`, `--to`, `--limit`). See the [CLI reference](/reference/cli) for the full flag list.

## Related

- [Daemon](/guide/daemon) — how sessions get harvested: the scan / watch / reconcile loop.
- [CLI Commands](/reference/cli) — the complete `ymesh` command surface, auto-generated from `ymesh help`.
- [MCP Server](/guide/mcp) — the MCP tools (`search_sessions`, `list_active_sessions`, `get_session_handoff`, `who_is_working`, …) that expose sessions to agents.
- [Architecture](/guide/architecture) — the three planes and the invariants that govern session storage.
