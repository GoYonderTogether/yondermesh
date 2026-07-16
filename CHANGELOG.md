# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Mailbox v3: synchronous injection (the Send capability)

The fifth capability closes the loop that the first four left open. Until v3 the
mesh was read-only by default — agents could see each other but could not talk
back. Now they can. `ymesh send` (CLI) and `yondermesh_send` (MCP tool)
synchronously inject a user message into any connected CLI agent and return the
cleaned reply, all in one call.

- **3-layer architecture**: `MailboxCore.send()` (message layer) →
  `TriggerAdapter.trigger()` (delivery layer, the only layer that touches a CLI
  process) → `ReplyAdapter.extractReply()` (pure-function reply cleaner, no I/O).
  The split keeps the message layer mockable for deterministic unit tests and
  the reply cleaner trivially testable.
- **6 trigger channels** — `cli-spawn`, `stdin`, `http-api`, `ws-rpc`, `tmux`,
  `applescript`. The adapter picks one per `TriggerMode` and per-CLI capability.
- **3 trigger modes** — `stopped` (resume a stopped session with `--resume` and
  a message flag), `running` (inject into a live session in-place),
  `new` (launch a fresh session, with optional `model` and `effort`).
- **28 CLIs wired** — claude, codex, hermes, gemini, goose, aider, amp, factory,
  vibe, codebuddy, trae-cli, opencode, qwen, openhands, kimi, openclaw, pi,
  copilot, crush, cline, continue, antigravity, plus the IDE class (trae-ide,
  windsurf, cursor-ide, chatgpt). Each loads its wrapper on demand via
  `WRAPPER_LOADERS` in `src/mcp/tools.ts`.
- **Failure is never silent.** `send()` never throws (except during argument
  validation) and never hangs. Unknown CLI, missing model, non-zero exit,
  upstream API rate-limit — all surface as text in `response` / `error`, with
  `delivered` / `exitCode` / `channel` / `latencyMs` populated. The caller
  always sees what went wrong.
- **Audit loop preserved.** v3 writes the user message (`kind=question`) and
  the reply (`kind=task_update`, linked via `replyToId` + `threadId=thread-<id>`)
  through the same `postMessage` path as v2, so legacy `yondermesh_mailbox_*`
  tools can still read v3 threads. v2 surface is retained and marked
  `(legacy v2, prefer yondermesh_send for sync delivery)` in tool descriptions.
- **CLI** — `ymesh send --cli <agent> [--session <id>] [--mode stopped|running|new]
  --message "text" [--model <m>] [--effort <e>] [--cwd <path>] [--timeout <ms>]
  [--from <sid>] [--json]`. Exit code 0 = delivered, 2 = not delivered, 1 =
  validation / exception.
- **MCP** — `yondermesh_send` with `cli` (required), `message` (required),
  `mode` (default `new`), `session_id`, `model`, `effort`, `cwd`, `timeout_ms`,
  `from_session_id`. Returns `{ cli, mode, ...SendResult }`.
- **Tests** — `tests/mailbox.test.ts` describes 11 & 12 cover the v3 path with
  a `FakeTriggerAdapter` (canned `TriggerResult`) plus a real-hermes
  integration skip-when-absent. `tests/mcp-mailbox.test.ts` covers
  `yondermesh_send` schema, validation errors, and legacy v2 tool descriptions.

Internal SDD: `docs/spec-mailbox-v3.md` (gitignored). Public docs: Trigger and
Mailbox sections in `ARCHITECTURE.md`, plus `yondermesh_send` in the MCP tools
reference.

### Added — docs & infra
- Public documentation site (`site/`, VitePress) with English + Chinese locales.
- Doc-code sync pipeline: `scripts/docs/sync-all.mjs`, `gen-cli-docs.mjs`, `gen-adapters.mjs`.
- CI workflows: `docs-deploy.yml` (main → GitHub Pages) and `docs-check.yml` (PR drift + link check).
- `doc-sync` skill (`skills/doc-sync/SKILL.md`) for reconciling docs with code.
- Top-level canonical docs: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`.
- `src/trigger/reply-adapter.ts` — pure-function `ReplyAdapter` + `stripAnsi`.
  Separates reply cleaning (no I/O, deterministic) from delivery (side-effectful).
- Trigger plane added to the architecture overview: yondermesh is now described
  as **four** planes (local / sync / mount / trigger), up from three.
- **Schema split** — `src/store/schema.ts` split into `SCHEMA` (CREATE TABLE only) + `SCHEMA_INDEXES` (CREATE INDEX) so migrations can run in between (fixes index creation on legacy DBs missing new columns).
- **`detect` module** — `src/detect/agents.ts` provides unified agent detection (installed / coverage / mount strategies / wrapper support) for CLI + MCP.
- **process-detector** — `src/store/process-detector.ts` infers alive sessions from PID + last-modified timestamps.
- **Skills** — 4 new skills: `doc-sync` (canonical at `skills/doc-sync/SKILL.md`), `new-cli-onboarding`, `yondermesh-mailbox`, `trae-awareness`, `yondermesh-diagnose`.

### Changed
- **`mapGenericWrapper` priority scan** — now scans `Controller > Wrapper > CliWrapper > ApiWrapper` suffixes (previously only `*Controller`), unblocking 7 wrapper-class inject methods that were previously shadowed.
- **`normalizeInjectResult`** — unifies heterogeneous wrapper inject return values (`{response,exitCode}` / `{ok,stdout,exitCode}` / `{channel,ok}` / `void`) into a single `{response, exitCode}` shape.
- **`src/mcp/tools.ts`** — `injectSessionHandler` now `await`s the wrapper inject call (was sync-only, causing unhandled rejections for async wrappers).
- **`gen-cli-docs.mjs`** — prefers `npx tsx src/bin/ymesh.ts` over PATH binaries, so generated docs reflect the latest source tree instead of a stale installed `ymesh`.

### Fixed
- **Schema migration order** — `CREATE INDEX idx_msg_thread ON agent_messages(thread_id)` failed on legacy DBs missing the `thread_id` column. Fixed by splitting `SCHEMA` (tables) → `MIGRATION_COLUMNS` (ALTER TABLE) → `SCHEMA_INDEXES` (indexes).
- **ESM `require()` in tests** — `tests/mcp-mailbox.test.ts` replaced `require('../src/daemon/index.js')` with static ESM import.
- **`process.env.X = undefined` pollution** — env recovery in tests now uses conditional `delete` instead of assigning `undefined` (which coerced to the string `"undefined"`).

## [0.1.0] — initial public release

### Added
- **Daemon + collector + local SQLite** — auto-harvests sessions from every CLI agent into `~/.yondermesh/yondermesh.db`.
- **MCP server** — stdio JSON-RPC. Tools: `recall_recent_work`, `whats_on_device`, `handoff_task`, `who_is_working`, `list_active_sessions`, `search_sessions`.
- **CLI adapters** — Claude Code, Codex, Aider, Cass, Hermes, Continue, Windsurf, Gemini, Cursor, Copilot, Cline, OpenCode, Kimi, Trae, and more (see `site/reference/adapters.md` for the full matrix).
- **Cross-device sync** — E2E-encrypted relay; ciphertext only leaves the device.
- **Mount system** — non-invasive MCP / skill / always-on injection into each CLI's config dir.
- **Install / release / update** — `ymesh install`, `ymesh update`, `ymesh rollback`, with auto-rollback on failure.
- **Daily briefing** — digest of agent activity across devices.
- **CLI** — `ymesh scan`, `sessions`, `active`, `daemon`, `mcp`, `mount`, `extract`, `handoff`, `state`, `mailbox`, `doctor`, etc.
