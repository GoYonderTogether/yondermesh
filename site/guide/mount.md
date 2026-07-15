---
title: Mount System
description: yondermesh mounts non-invasive extensions (MCP server, skill, always-on paragraph) into each CLI's own config directory — no CLI binary is ever modified.
outline: [2, 3]
---

# Mount System

The mount system is how yondermesh extends other CLIs without modifying them. A **mount** installs a ymesh extension into a CLI's own config directory (`~/.claude/`, `~/.codex/`, `~/.cursor/`, …). The CLI picks the extension up through its native config-reading mechanism — ymesh only writes files and symlinks into the CLI's config dir, never patches the CLI binary or its session writer.

This is the **Mount plane** of yondermesh's three-plane architecture (Local, Sync, Mount). It is implemented in `src/mount/` and is the single entry point for getting ymesh capabilities into every supported CLI on a machine.

## What mounts are

A mount is a triple of *(CLI, extension, strategy)*:

- A **CLI** is a target like `codex`, `claude-code`, `cursor`, `trae`. Each is declared in `src/mount/registry.ts` with a detection rule (usually "does `~/.<dir>` exist?") and a list of capabilities.
- An **extension** is something ymesh wants to install: an MCP server, a skill, or an always-on paragraph. `defaultExtensions()` in `src/mount/manager.ts` is the canonical list of what ymesh mounts.
- A **strategy** is how a given extension type is installed for a given CLI: `mcp-json`, `mcp-toml`, `mcp-toml-array`, `claude-mcp`, `skill-symlink`, or `always-on`. Strategies are implemented in `src/mount/strategies.ts`.

Each strategy knows how to `mount`, `unmount`, and report `isMounted` for its extension type. The mount manager iterates detected CLIs × extensions and dispatches each pair to the matching strategy.

## The three extension types

`ExtensionType` in `src/mount/types.ts` defines exactly three:

- **`mcp-server`** — a stdio MCP server entry written into the CLI's MCP config (JSON or TOML, depending on the CLI). The server itself is `ymesh mcp`. See [MCP Server](/guide/mcp).
- **`skill`** — a symlink into the CLI's skill directory pointing at a ymesh skill under `releases/current/skills/<name>/`. See [Skills System](/guide/skills).
- **`plugin`** (always-on paragraph) — a fenced paragraph injected into one of the CLI's global instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, …). The paragraph tells every new session that ymesh is installed and what it can do.

The default extension set (`defaultExtensions()` in `src/mount/manager.ts`) mounts:

1. The yondermesh MCP server (`mcp-server`).
2. The `yondermesh-diagnose` skill (`skill`).
3. The `trae-awareness` skill (`skill`) — the Trae-specific substitute for always-on injection.
4. The yondermesh awareness paragraph (`plugin` / always-on).

Not every extension type is supported by every CLI. The mount manager skips `(cli, extension)` pairs the CLI does not support and reports them as `unsupported` rather than failing.

## Mount management commands

```bash
ymesh mount status    # Show what is mounted where
ymesh mount all       # Mount every default extension into every detected CLI
ymesh mount remove    # Unmount every ymesh extension from every CLI
```

`ymesh mount all` is idempotent: re-running it refreshes symlinks and rewrites config blocks to match the current release. It is the recommended way to pick up a new ymesh version after `ymesh update`.

### `ymesh mount status`

Walks every detected CLI and every default extension, and reports whether each is currently mounted. Output is a list of `(cli, extension, type, strategy, mounted)` rows. Use it to verify a mount round-trip or to debug why a particular CLI did not pick up ymesh.

### `ymesh mount all`

Detects installed CLIs via each `CliTarget.detect()` rule (with OpenSpace residual directories filtered out), then for each `(cli, extension)` pair where the CLI supports the extension type, dispatches to the matching strategy. Results are collected as `MountResult` rows with `success`, `message`, and the resolved target path.

### `ymesh mount remove`

Unmounts every ymesh extension from every detected CLI. For config-rewriting strategies this removes the ymesh block; for `skill-symlink` it removes the symlink; for `claude-mcp` it calls `claude mcp remove`. Safe to run repeatedly.

## Supported CLIs and their strategies

The public CLI coverage table (from the repo README, sourced from `src/mount/registry.ts`):

| CLI | MCP mount | Skill mount | Always-on injection |
|---|---|---|---|
| codex | mcp-toml (`~/.codex/config.toml`) | skill-symlink (`~/.codex/skills/`) | `~/.codex/AGENTS.md` |
| claude-code | claude-mcp (`claude mcp add`) | — | `~/.claude/CLAUDE.md` |
| cursor | mcp-json (`~/.cursor/mcp.json`) | skill-symlink (`~/.cursor/skills/`) | `~/.cursorrules` |
| gemini | mcp-json (`~/.gemini/settings.json`) | — | `~/.gemini/GEMINI.md` |
| windsurf | mcp-json (`~/.codeium/windsurf/mcp_config.json`) | skill-symlink (`~/.codeium/windsurf/skills/`) | `~/.windsurfrules` |
| trae | — | skill-symlink (`~/.trae/skills/`) | — |
| trae-cn | — | skill-symlink (`~/.trae-cn/skills/`) | — |
| continue | — | skill-symlink (`~/.continue/skills/`) | — |

The registry declares many more CLIs (Factory, Vibe, CodeBuddy, Copilot, Pi / OMP / GSD-Pi, OpenHands, Goose, Crush, Cline, Antigravity, Amp, Qwen, Hermes, plus IDE-shared variants). Some CLIs (Aider, OpenClaw, Kimi, ChatGPT desktop) declare no mount capabilities and are detected-but-not-mounted. The live, auto-regenerated matrix is on the [CLI Adapters](/reference/adapters) page.

## Strategy implementations

Each strategy lives in `src/mount/strategies.ts` and exposes `mount` / `unmount` / `isMounted`. The `MountStrategyType` union in `src/mount/types.ts` is the canonical list.

### `mcp-json` (Cursor / Gemini / Windsurf / Factory / CodeBuddy / Copilot / Crush / Cline / Amp / Pi-family / Antigravity)

Writes an `mcpServers.<name>` key into a JSON config file. The file path is resolved per-CLI from the registry (for example `~/.cursor/mcp.json`, `~/.gemini/settings.json`). Mount reads the JSON safely (treating a missing or malformed file as `{}`), sets `mcpServers[ext.name] = { command, args, env? }`, and writes it back pretty-printed. Unmount deletes the key. `isMounted` checks for the key's presence.

### `mcp-toml` (Codex / OpenHands / Trae CLI / Goose)

Writes a `[mcp_servers.<name>]` section into a TOML config file using text operations (no TOML parser dependency). Mount first removes any existing section for the same name (including `[mcp_servers.<name>.env]` subtables), then appends a fresh section with `command`, `args`, and an optional `[mcp_servers.<name>.env]` subtable. Unmount removes the section. `isMounted` checks for the `[mcp_servers.<name>]` header.

### `mcp-toml-array` (Vibe)

Writes a `[[mcp_servers]]` array-of-tables entry into a TOML config file. Vibe uses array-of-tables rather than Codex's named-subtable form. Each entry carries `name`, `transport`, `command`, `args`, and timeout fields. Mount removes any existing entry whose `name` matches, then appends a new entry at the end of the file (top-level scalars are unaffected, which avoids the TOML "scalar after table" pitfall). Unmount removes the matching entry.

### `claude-mcp` (Claude Code)

Claude Code stores MCP server config in an internal database, not in a JSON file. This strategy shells out to the `claude` CLI: `claude mcp add <name> -s user -- <command> <args…>` to mount, and `claude mcp remove <name> -s user` to unmount. Mount removes any existing entry first (idempotent). `isMounted` runs `claude mcp list` and checks for the name. This is the strategy used by `ymesh mount all`; the older `ymesh mcp register` writes `~/.claude.json` directly instead — both work, the mount system is the recommended path.

### `skill-symlink` (Codex / Cursor / Windsurf / Trae / Trae CN / Continue / Factory / Vibe / CodeBuddy / Copilot / Pi-family / OpenHands / Goose / Crush / Cline / Antigravity / Amp)

Creates a directory symlink from `<cli skills dir>/<name>` to `releases/current/skills/<name>`. Mount creates the skills directory if needed, removes any existing link at the target path (regardless of where it pointed), and creates a fresh symlink. `isMounted` verifies the link exists, is a symbolic link, and that its target contains `yondermesh`, `ymesh`, or `release` — this prevents a same-named link created by another tool from being misreported. See [Skills System](/guide/skills).

### `always-on` (Codex / Claude Code / Cursor / Gemini / Windsurf / and others)

Injects a fenced paragraph into one of the CLI's global instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `SOUL.md` for Hermes, …). The paragraph is wrapped in `<!-- YONDERMESH_AWARENESS_START -->` / `<!-- YONDERMESH_AWARENESS_END -->` markers so it can be found and replaced idempotently. Mount removes any existing block first, then appends the new block. `isMounted` checks for both markers. The paragraph content is generated by `generateContextBlock()` in `src/mount/manager.ts` and tells the agent that ymesh is installed, what MCP tools are available, and which CLI commands to use.

## The Trae four-variant mechanism

Trae actually ships four client variants that all need coverage: Trae IDE (international), Trae IDE CN (Chinese), Trae Work (international), and Trae Work CN (Chinese). ymesh covers all four with just **two** `CliTarget` entries (`trae` + `trae-cn`):

- There are only two physical user-level directories: `~/.trae` (international) and `~/.trae-cn` (Chinese).
- Within each directory, Trae IDE and Trae Work share the user-level `skills/` directory (they use different profiles, but the user-level skills directory is shared).
- So mounting two `CliTarget`s (`trae` + `trae-cn`) covers all four variants (IDE + Work × international + Chinese).

Trae's mount strategy differs from the other CLIs in two important ways:

- **No always-on injection.** Trae does not read global instruction files like `project_rules.md` (it injects via system prompt plus the skills directory, not global instruction files). ymesh substitutes the `trae-awareness` skill for the always-on awareness paragraph, so Trae discovers ymesh in its skill list at session start. This is why `defaultExtensions()` pushes the `trae-awareness` skill separately from the generic awareness paragraph.
- **No file-based MCP mount.** Trae configures MCP through the IDE settings UI, not through a file ymesh can write. To use ymesh MCP tools inside Trae, add the MCP server manually in Trae's settings: command `ymesh`, args `["mcp"]`. See [MCP Server - Trae](/guide/mcp#trae).

## Verification

`ymesh mount status` is the canonical verification command. It reports, for every detected CLI and every default extension, whether the extension is currently mounted and via which strategy. Use it after `ymesh mount all` to confirm everything landed, and after `ymesh mount remove` to confirm everything was cleaned up.

The status check for each strategy mirrors its mount check: `mcp-json` looks for the `mcpServers` key, `mcp-toml` scans for the section header, `claude-mcp` runs `claude mcp list`, `skill-symlink` verifies the symlink target, and `always-on` checks for both boundary markers. A mount is only reported as `mounted: true` when the strategy's specific check passes — not merely when the file exists.

## Related

- [MCP Server](/guide/mcp) — the `mcp-server` extension type and the `ymesh mcp` server.
- [Skills System](/guide/skills) — the `skill` extension type and the `skill-symlink` strategy.
- [CLI Adapters](/reference/adapters) — auto-generated live matrix of CLI support.
- [CLI Commands](/reference/cli) — `ymesh mount` subcommand reference.
