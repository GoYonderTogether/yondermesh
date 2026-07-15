# ARCHITECTURE

> yondermesh's bird's-eye view + codemap. Answers two questions: **"Where does the code for X live?"** and **"What is this module I'm looking at actually doing?"**
> Rule (following matklad's *ARCHITECTURE.md* advice): write only the things that don't change often. **Name files but don't paste line-level links** (use symbol search). Don't try to stay in sync line-by-line with the code; revisit when modules are added or boundaries move. Inline comments carry the detail.
> All descriptions are grounded in the actual `src/` code.

## I. Overview

**yondermesh** is a self-hosted Agent Context Bus: one daemon + one MCP server that lets your AI coding agents share a single working surface across devices and CLIs. Sessions are harvested from each CLI's native format into local SQLite; an MCP server exposes query and handoff tools to any MCP-capable agent; cross-device sync moves ciphertext only over a self-hosted relay.

> **Core mental model**: an agent's session is the unit of context. Sessions have topology (`root` / `subagent` / `sidechain`), source (`claude` / `codex` / `cass` / `hermes` / `continue` / `windsurf` / …), and project (`cwd` / `projectPath`). Every MCP tool is a structured query over this session graph. Every adapter is a reader of one CLI's native format. Every mount is a non-invasive extension (MCP / skill / always-on) installed into a CLI's config without modifying the CLI itself.

Three planes that never cross-contaminate:

```
Local plane        CLI native files → adapter → SessionStore (SQLite) → MCP server (stdio)
Sync plane         SessionStore → relay agent → self-hosted relay (ciphertext only) → peer device
Mount plane        ymesh skills / MCP config → CLI's own config dir (~/.claude/, ~/.codex/, ~/.cursor/, …)
```

**Daemon lifecycle**: `start → scan-once → watch (fs events) → periodic reconcile → idle`. Reads native files only; never modifies them. The CLI is a thin wrapper over the same `SessionStore` — `ymesh scan`, `ymesh sessions`, `ymesh active` are direct store queries.

## II. Codemap (what each file/directory does)

### CLI entry & command surface (`src/bin/`, `src/`)

- `src/bin/ymesh.ts` — **CLI entry point**. Parses argv, dispatches to `cmd*` functions. No external CLI framework (pure hand-rolled `parseArgs`). Commands: `help`, `version`, `scan`, `status`, `sessions`, `active`, `daemon`, `install`, `service`, `releases`, `update`, `rollback`, `mcp`, `doctor`, `mount`, `extract`, `handoff`, `state`, `mailbox`. Supports `--json` global flag for script consumption. The help text in `cmdHelp()` is the canonical command list — `site/reference/cli.md` is auto-regenerated from it by `scripts/docs/gen-cli-docs.mjs`.
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

- `src/mcp/server.ts` — `McpServer` class. stdio JSON-RPC. Tools: `recall_recent_work`, `whats_on_device`, `handoff_task`, `who_is_working`, `list_active_sessions`, `search_sessions`, … (`site/reference/mcp-tools.md` is the canonical list).
- `src/mcp/register.ts` — registers the ymesh MCP server into Claude Code (`claude mcp add`) and Codex (`~/.codex/config.toml`). `registerAll` / `unregisterAll` / `checkRegistration`.
- `src/mcp/codex-handoff.ts` — builds a `HandoffPackage` (compacted summaries + recent messages + task plan) for a session id. Used by `ymesh handoff` and the `handoff_task` MCP tool.

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
- `scripts/docs/` never imports from `src/`. It shells out to `ymesh help` and reads `src/*/` as plain files. This keeps the docs generator decoupled from internal refactors.
