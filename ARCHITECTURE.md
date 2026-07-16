# ARCHITECTURE

> yondermesh's bird's-eye view + codemap. Answers two questions: **"Where does the code for X live?"** and **"What is this module I'm looking at actually doing?"**
> Rule (following matklad's *ARCHITECTURE.md* advice): write only the things that don't change often. **Name files but don't paste line-level links** (use symbol search). Don't try to stay in sync line-by-line with the code; revisit when modules are added or boundaries move. Inline comments carry the detail.
> All descriptions are grounded in the actual `src/` code.

## 0. Product narrative

You don't use one AI coding agent. You use Claude Code, Codex, Aider, Gemini CLI, Cursor, Windsurf, Trae, Continue, OpenCode, Hermes, and a dozen more — spread across laptop, desktop, and server. Each one is an island. Context dies at the session boundary. Agent A on your laptop has no idea what Agent B on your desktop just did.

**yondermesh is the collaboration hub of the Agent era.** One daemon, one MCP server, zero intrusion — it aggregates every CLI agent on every device into a single working whole with cross-platform memory, cross-device real-time awareness, and continuous handoff. Five capabilities form the loop:

- **Collect** — every session from every CLI on every device flows into one local SQLite. Your agents stop being islands and start acting as one working whole.
- **Sync** — E2E-encrypted cross-device sync via a self-hosted relay. Only ciphertext ever leaves your machine.
- **Query** — any agent queries any other agent's context via MCP tools. Topology-aware, source-aware, project-aware.
- **Hand off** — agent A picks up exactly where agent B stopped, even on a different machine. Sessions stop dying at the boundary; they become a continuous workflow.
- **Send** — synchronously inject a user message into any connected CLI agent and get the reply back. 28 CLIs, 6 trigger channels, 3 modes (stopped / running / new). Failure is never silent.

The hub is a deliberately small piece of infrastructure: not another CLI, not another model, not another cloud. It makes the agents you already use act as one.

## I. Overview

**yondermesh** is a self-hosted Agent Context Bus: one daemon + one MCP server that lets your AI coding agents share a single working surface across devices and CLIs. Sessions are harvested from each CLI's native format into local SQLite; an MCP server exposes query and handoff tools to any MCP-capable agent; cross-device sync moves ciphertext only over a self-hosted relay; the trigger layer synchronously injects user messages into any connected CLI and returns the cleaned reply.

> **Core mental model**: an agent's session is the unit of context. Sessions have topology (`root` / `subagent` / `sidechain`), source (`claude` / `codex` / `cass` / `hermes` / `continue` / `windsurf` / …), and project (`cwd` / `projectPath`). Every MCP tool is a structured query over this session graph. Every adapter is a reader of one CLI's native format. Every mount is a non-invasive extension (MCP / skill / always-on) installed into a CLI's config without modifying the CLI itself. Every `send` is a synchronous round-trip through the trigger layer (message → trigger → reply → audit).

Four planes that never cross-contaminate:

```
Local plane        CLI native files → adapter → SessionStore (SQLite) → MCP server (stdio)
Sync plane         SessionStore → relay agent → self-hosted relay (ciphertext only) → peer device
Mount plane        ymesh skills / MCP config → CLI's own config dir (~/.claude/, ~/.codex/, ~/.cursor/, …)
Trigger plane      MailboxCore → TriggerAdapter (cli-spawn / stdin / http-api / ws-rpc / tmux / applescript) → target CLI → ReplyAdapter → audit log
```

**Daemon lifecycle**: `start → scan-once → watch (fs events) → periodic reconcile → idle`. Reads native files only; never modifies them. The CLI is a thin wrapper over the same `SessionStore` — `ymesh scan`, `ymesh sessions`, `ymesh active` are direct store queries.

## II. Codemap (what each file/directory does)

### CLI entry & command surface (`src/bin/`, `src/`)

- `src/bin/ymesh.ts` — **CLI entry point**. Parses argv, dispatches to `cmd*` functions. No external CLI framework (pure hand-rolled `parseArgs`). Commands: `help`, `version`, `scan`, `status`, `sessions`, `query`, `active`, `waiting`, `daemon`, `install`, `service`, `releases`, `update`, `rollback`, `mcp`, `doctor`, `mount`, `extract`, `handoff`, `state`, `mailbox`, `agents`, `launch`, `inject`, `transfer`, `send`. Supports `--json` global flag for script consumption. The help text in `cmdHelp()` is the canonical command list — `site/reference/cli.md` is auto-regenerated from it by `scripts/docs/gen-cli-docs.mjs`.
- `src/index.ts` — **Public SDK entry**. Re-exports every adapter's importer/wrapper/inject types so external code can build on top of ymesh without reaching into `src/<adapter>/` directly.

### Session storage (`src/store/`)

- `src/store/index.ts` — `SessionStore` class: the only writer/reader of SQLite. Query surface: `querySessions`, `getSessionStats`, `getActiveSessionsSummary`, `getSourceBreakdown`, `deduplicateCrossSource`. Topology-aware (root / subagent / sidechain).
- `src/store/schema.ts` — SQLite schema (CREATE TABLE / index statements). Canonical data model truth; change here first.
- `src/store/session-store.ts` — Session upsert / dedup logic.
- `src/store/source-aliases.ts` — Maps raw source names (e.g. `claude-code`, `ClaudeCode`) to canonical ymesh source IDs (e.g. `claude`).
- `src/store/types.ts` — Public types: `SessionRecord`, `SessionMessage`, `SessionQuery`, `SessionStats`, `SessionTopology`, `RelationType`, …

### CLI adapters (`src/<adapter>/`)

Every supported CLI agent has its own directory under `src/`. Each adapter follows the same file pattern (not all files are present for every adapter — see `site/reference/adapters.md` for the live matrix):

- `importer.ts` — **A-level**: native importer. Reads the CLI's native session files (JSONL / session DB / git log) directly into `SessionStore`. Coverage A.
- `wrapper.ts` — **B-level**: builds the command line to invoke the wrapped CLI (e.g. `aider --model X`, `amp export`). Not a session reader; a launcher.
- `inject.ts` — **B-level**: generates config snippets to inject into the CLI's own config (e.g. MCP server JSON, agents.md, plugin hooks).
- `extractor.ts` — **C-level**: live extractor (e.g. transcript hook). Partial coverage; usually complements a B-level wrapper.
- `index.ts` — public exports for the adapter; the first file to read to understand what the adapter does. `scripts/docs/gen-adapters.mjs` reads each `index.ts`'s header comment for the support matrix notes.

Adapters present (alphabetical): `aider`, `amp`, `antigravity`, `cass`, `chatgpt`, `claude`, `cline`, `codebuddy`, `codex`, `continue`, `copilot`, `crush`, `cursor-ide`, `factory`, `gemini`, `goose`, `hermes`, `kimi`, `openclaw`, `opencode`, `openhands`, `pi`, `qwen`, `trae-cli`, `trae-ide`, `vibe`, `windsurf`.

### Daemon (`src/daemon/`)

- `src/daemon/index.ts` — `YondermeshDaemon` class. `start()` runs the scan-once + watch + reconcile loop. `stop()` is graceful (SIGINT/SIGTERM wired in `cmdDaemon`).
- `src/daemon/config.ts` — `defaultDaemonConfig()` / `defaultDataDir()`. Resolves `~/.yondermesh/` paths; honors `YONDERMESH_HOME` override.

### MCP server (`src/mcp/`)

- `src/mcp/server.ts` — `McpServer` class. stdio JSON-RPC. `listTools()` merges legacy tools (defined inline in `server.ts`) with the `yondermesh_*` registry (`src/mcp/tools.ts`). `callTool()` routes to legacy first, then new tools, then injects the **Channel A** piggyback hint (`📬 mailbox: N unread`) when the calling session has unread mailbox messages.
- `src/mcp/register.ts` — registers the ymesh MCP server into Claude Code (`claude mcp add`) and Codex (`~/.codex/config.toml`). `registerAll` / `unregisterAll` / `checkRegistration`.
- `src/mcp/codex-handoff.ts` — builds a `HandoffPackage` (compacted summaries + recent messages + task plan) for a session id. Used by `ymesh handoff` and the `handoff_task` MCP tool.
- `src/mcp/tools.ts` — registry of `yondermesh_*` tools: `list_agents` / `query_sessions` / `get_session` / `launch_agent` / `inject_session` / `transfer_session` / `mount_status` + the mailbox quartet (`mailbox_check` / `mailbox_post` / `mailbox_reply` / `whoami`, marked legacy v2) + `yondermesh_send` (v3 sync injection). Each handler is self-contained (opens its own `SessionStore` / `MailboxCore`), avoiding cross-call shared state.

### Trigger (`src/trigger/`)

The trigger layer is yondermesh's delivery-and-reply plane: it takes a `TriggerRequest` (a user message + target CLI + mode) and returns a `TriggerResult` (raw response + exit code + channel). It is split into two adapters so the message layer (`MailboxCore`) never touches a CLI process directly.

```
Message layer (MailboxCore.send)
        │  TriggerRequest
        ▼
TriggerAdapter ──► target CLI (cli-spawn / stdin / http-api / ws-rpc / tmux / applescript)
        │  TriggerResult (raw response)
        ▼
ReplyAdapter ──► cleaned reply text (strips ANSI, CLI noise, log/banner lines)
        │  ReplyResult
        ▼
back to MailboxCore (audit-write + return SendResult)
```

- `src/trigger/adapter.ts` — `TriggerAdapter` class. `trigger(req)` resolves the target CLI's wrapper (via `src/mcp/tools.ts` `WRAPPER_LOADERS`), picks a channel by `TriggerMode` (`stopped` → resume + inject, `running` → inject into live session, `new` → launch fresh), and returns a `TriggerResult`. This is the only place that actually spawns or talks to a CLI process.
- `src/trigger/reply-adapter.ts` — `ReplyAdapter` class. `extractReply(result, cli)` is a **pure, side-effect-free** text cleaner: (1) `stripAnsi()` removes CSI/OSC escapes; (2) `applyCliSpecificFilter()` drops per-CLI noise (e.g. hermes `Warning: Unknown toolsets:` lines, claude `Tip:` lines); (3) `applyGenericFilter()` removes log prefixes (`warning|warn|debug|info|error|fatal|trace|verbose:`) and startup banners (`Welcome|Booting|Starting|Loaded|Initializing|Copyright`); (4) `collapseBlankLines()` folds 3+ newlines to 2 and trims. Never throws — returns empty string when `delivered=false` or the cleaned text is empty. `ReplyResult.source` is derived from `TriggerChannel` (http-api/ws-rpc → `api`; tmux/applescript → `tmux-capture`; cli-spawn/stdin → `stdout`).
- `src/trigger/types.ts` — `TriggerMode`, `TriggerChannel`, `TriggerRequest`, `TriggerResult`, `ReplyResult` (`{ text, source, latencyMs }`), `CliTriggerCapability`.
- `src/trigger/index.ts` — barrel; re-exports `ReplyAdapter` and `stripAnsi` (as `stripReplyAnsi`).

### Mailbox (`src/mailbox/`)

The mailbox is yondermesh's cross-session message bus. One `MailboxCore` business layer backs both the `ymesh mailbox` / `ymesh send` CLI commands and the `yondermesh_mailbox_*` / `yondermesh_send` MCP tools — CLI and MCP are thin shells, never re-implementing logic.

**v3 sync-injection model (primary).** `MailboxCore.send(target: SendTarget): Promise<SendResult>` is the unified entry point for synchronous message delivery. It orchestrates the 3-layer architecture (message → trigger → reply): audit-writes the user message (`kind=question`) → `TriggerAdapter.trigger()` delivers it to the target CLI → `ReplyAdapter.extractReply()` cleans the raw response → audit-writes the reply (`kind=task_update`, linked via `replyToId` + `threadId=thread-<messageId>`) → returns `SendResult`. Even on failure (unknown CLI, trigger throws, non-zero exit, upstream API rate-limit) the call returns with `delivered`/`error`/`response` populated instead of hanging — the CLI's own error text surfaces in `response` so the caller can see what went wrong. The constructor accepts optional `TriggerAdapter` / `ReplyAdapter` for DI (deterministic unit tests inject a `FakeTriggerAdapter`).

**v2 async model (legacy, retained for audit reads).** The original `postMessage` / `peekMessages` / `popMessages` / `markRead` / `countUnread` / `listMailboxes` / `cleanupExpired` / `consumeTray` / `writeTrayNotice` / `resolveSelfSession` / `registerNotifier` surface is kept (`postMessage` is `@deprecated` in JSDoc but unchanged in behavior). These power the legacy `yondermesh_mailbox_*` MCP tools (marked `(legacy v2, prefer yondermesh_send for sync delivery)` in their descriptions) and serve as the audit-trail reader for both v2 and v3 (v3 `send()` writes its user message and reply through the same `postMessage` path so they appear in `agent_messages` and are queryable by the legacy tools).

- `src/mailbox/core.ts` — `MailboxCore` class. Surface: `send` (v3) + `postMessage` / `peekMessages` / `popMessages` / `markRead` / `countUnread` / `listMailboxes` / `cleanupExpired` / `consumeTray` / `writeTrayNotice` / `resolveSelfSession` / `registerNotifier` (v2). `resolveSelfSession()` is three-layer (env `YONDERMESH_SELF_SESSION_ID` → explicit arg → cwd match against live sessions). `countUnread()` excludes self-broadcasts (`from_session_id != me`). Notifier is `NoopNotifier` by default; daemon swaps it for a tray-file pusher via `registerNotifier()`.
- `src/mailbox/types.ts` — `MailboxMessage`, `PostMessageInput`, `MessageFilter`, `MarkReadInput`, `UnreadCount`, `TrayNotice`, `MailboxNotifier` / `NoopNotifier`; v3 types `SendMode` / `SendTarget` / `SendResult`. Exports `MAIL_KINDS` / `MAIL_PRIORITIES` for CLI validation.
- `src/mailbox/index.ts` — barrel.

Schema lives in `src/store/schema.ts` (`agent_messages` table): added `priority` / `expires_at` / `thread_id` / `reply_to_id` columns + 3 indexes (`idx_msg_unread`, `idx_msg_thread`, `idx_msg_expires`); `MIGRATION_COLUMNS` has the backward-compat `ALTER TABLE` entries.

Daemon integration: when daemon is online, it calls `registerNotifier()` to push new messages to `~/.yondermesh/mailbox-tray/<sid>.txt`; `mailbox_check` consumes these tray files. When daemon is offline, mailbox degrades to polling (peek on each MCP call, <1ms).

### Mount system (`src/mount/`)

The mount system extends ymesh's reach into other CLIs without modifying them. Each "mount" installs a ymesh extension (MCP server / skill / always-on paragraph) into a CLI's own config dir.

- `src/mount/manager.ts` — `mountAll` / `unmountAll` / `verifyAll`. Iterates detected CLIs and applies each extension's strategy.
- `src/mount/registry.ts` — Declares which CLIs are supported and which extension strategies each one supports (MCP / skill / always-on).
- `src/mount/strategies.ts` — Per-strategy implementations: `mcp-toml` (codex), `claude-mcp` (claude-code), `mcp-json` (cursor / gemini / windsurf), `skill-symlink` (trae / continue / codex / cursor / windsurf), always-on injection (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.cursorrules`, `~/.gemini/GEMINI.md`, `~/.windsurfrules`).
- `src/mount/types.ts` — `CliTarget`, `MountStrategy`, `MountResult`, `MountStatus`.

### Install / release / update (`src/install/`)

- `src/install/index.ts` — barrel re-export.
- `src/install/release.ts` — `buildRelease(sourceRoot, force)`: compiles TS → bundles into a versioned release dir under `~/.yondermesh/releases/<version>/`. `installRelease`, `listReleases`, `getCurrentRelease`, `rollbackRelease`.
- `src/install/launcher.ts` — generates the `~/.yondermesh/bin/ymesh` symlink that points to the current release.
- `src/install/updater.ts` — `updateFromGit(repoUrl, branch)`: clone / pull → build → install → atomic symlink swap → auto-rollback on failure.
- `src/install/skill-linker.ts` — `linkSkills` / `unlinkSkills`: symlinks ymesh skills (`skills/<name>/`) into each CLI's skill dir (`~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/skills/`, `~/.windsurf/skills/`, `~/.trae/skills/`, `~/.trae-cn/skills/`, `~/.continue/skills/`).
- `src/install/paths.ts` — central path resolution (`~/.yondermesh/`, release dirs, symlinks).
- `src/install/version.ts` — version comparison helpers.

### Extract (`src/extract/`)

- `src/extract/extractor.ts` — `extractProject`: dumps every user requirement + assistant response for a project to NDJSONL files (one per kind), indexed by line number / session id. Powers `ymesh extract`.
- `src/extract/index.ts` — `queryExtracts` reads those NDJSONL files back with filters (id / keyword / session / limit / offset). Powers `ymesh extract --requirements --id N`.

### Briefing (`src/briefing/`)

- `src/briefing/generator.ts` — daily digest: "your N agents across M devices did K tasks today, X% success rate". Output goes to `~/.yondermesh/briefings/`.

### Sync (`src/sync/`)

- `src/sync/agent.ts` — cross-device sync agent. Reads new sessions from `SessionStore`, encrypts with the local key, pushes to the self-hosted relay. Pulls peer updates and decrypts. **Ciphertext only leaves the device.**

### Public docs site (`site/`, `scripts/docs/`)

- `site/` — VitePress site. Config: `site/.vitepress/config.ts`. Content: `site/guide/*.md` (hand-written), `site/reference/*.md` (mix of hand-written and auto-generated).
- `scripts/docs/sync-all.mjs` — orchestrator. Runs every `gen-*.mjs`.
- `scripts/docs/gen-cli-docs.mjs` — runs `ymesh help`, parses the output, writes `site/reference/cli.md` (en) and `site/zh/reference/cli.md` (zh).
- `scripts/docs/gen-adapters.mjs` — walks `src/*/`, classifies each adapter, writes `site/reference/adapters.md` (en + zh).
- `scripts/docs/check-drift.mjs` — re-runs sync, fails if any auto-generated file changed.
- `scripts/docs/verify-links.mjs` — walks `site/**/*.md`, asserts every internal link resolves.

## III. Architectural invariants

1. **No CLI modification.** Adapters read native files; mounts write into the CLI's own config dir but never patch the CLI binary or its session writer.
2. **No model proxy.** ymesh never touches API keys. The CLI runs the model; ymesh only reads what the CLI wrote.
3. **No cloud lock-in.** Sync relay is self-hostable. Cloud relay is optional convenience and never sees plaintext.
4. **No UI.** Config-file driven; daemon runs headless. The docs site (`site/`) is for humans reading about ymesh, not for operating it.
5. **Topology-aware.** Every session has a topology (`root` / `subagent` / `sidechain`). Queries that don't explicitly ask for subagents return roots only by default.
6. **Source-canonical.** Every session has a canonical source ID (e.g. `claude`, not `ClaudeCode` or `claude-code`). `source-aliases.ts` normalizes.
7. **Doc lag = bug.** Code change = doc change in the same commit. `scripts/docs/check-drift.mjs` and `scripts/docs/verify-links.mjs` enforce this in CI.

## IV. Module boundaries

- `src/store/` is the only writer to SQLite. Adapters call `SessionStore` methods; they never write SQL directly.
- `src/bin/ymesh.ts` is the only place commands are registered. Adding a command = adding a `case` to the `main()` switch + a `cmd*` function.
- `src/mount/` never imports from `src/<adapter>/`. Mount strategies are CLI-config-driven, not adapter-driven.
- `src/mailbox/` is the only place mailbox business logic lives. CLI (`src/bin/ymesh.ts` `cmdMailbox` / `cmdSend`) and MCP (`src/mcp/tools.ts` mailbox + `yondermesh_send` handlers) are thin shells — they open a `MailboxCore`, call a method (`send` / `postMessage` / …), format output. Never re-implement mailbox logic in the shell layers.
- `src/trigger/` is the only place that spawns or talks to a target CLI process for delivery. `MailboxCore.send()` delegates to `TriggerAdapter` for delivery and `ReplyAdapter` for reply cleaning; the message layer never imports a CLI wrapper directly. `ReplyAdapter` is pure (no I/O, no process calls) so it is safe to unit-test deterministically.
- `scripts/docs/` never imports from `src/`. It shells out to `ymesh help` and reads `src/*/` as plain files. This keeps the docs generator decoupled from internal refactors.
