---
title: File Layout
description: Repository, source, runtime, and docs-site file layout for yondermesh — what each directory contains and which docs are auto-generated.
outline: [2, 3]
---

# File Layout

This page maps the yondermesh project: where the code lives, where the runtime writes files, and which docs are hand-written vs auto-generated. Grounded in `ARCHITECTURE.md` plus the actual repository tree.

## Repository layout

Top-level structure of the repo:

```
yondermesh/
├── src/                  TypeScript source (daemon, MCP server, adapters, store, ...)
├── tests/                Vitest test suite (one *.test.ts per adapter + core modules)
├── site/                 VitePress documentation site (this site)
├── scripts/              Repo scripts
│   ├── extract_bp_sessions.py
│   └── docs/             Doc-generation pipeline (sync-all.mjs, gen-*.mjs, check-drift.mjs, verify-links.mjs)
├── skills/               ymesh skills shipped with the repo (doc-sync, trae-awareness, ...)
├── specs/                Internal specs (adapter-spec.md)
├── .github/workflows/    CI: docs-deploy.yml, docs-check.yml
├── .ymesh-runtime/       Local runtime state (current.json) — not part of public install
├── AGENTS.md             Canonical agent instructions
├── ARCHITECTURE.md       Bird's-eye codemap (source of truth for this page)
├── CHANGELOG.md          Release history (source of truth for /reference/changelog)
├── CONTRIBUTING.md       Contribution guide
├── README.md             Project overview + quickstart
├── SECURITY.md           Security policy
├── LICENSE               MIT
├── install.sh            Bootstrap installer
├── package.json          npm manifest
├── tsconfig.json         TypeScript config
└── vitest.config.ts      Test runner config
```

## src/ layout

Every supported CLI agent has its own directory under `src/`. Each adapter follows the same file pattern (not every file is present for every adapter — see `/reference/adapters` for the live matrix).

```
src/
├── bin/
│   └── ymesh.ts            CLI entry point (argv parsing, command dispatch)
├── index.ts                Public SDK entry — re-exports adapter types
├── store/                  Session storage (the only writer to SQLite)
│   ├── index.ts            SessionStore class — query surface
│   ├── schema.ts           SQLite schema (CREATE TABLE / indexes)
│   ├── session-store.ts    Upsert / dedup logic
│   ├── source-aliases.ts   Raw source names -> canonical source IDs
│   └── types.ts            SessionRecord, SessionQuery, SessionStats, ...
├── daemon/                 Daemon lifecycle
│   ├── index.ts            YondermeshDaemon (start/stop, scan+watch+reconcile loop)
│   └── config.ts           defaultDaemonConfig / defaultDataDir (YONDERMESH_HOME)
├── mcp/                    MCP server
│   ├── server.ts           McpServer class — stdio JSON-RPC, tool list (see /reference/mcp-tools)
│   ├── register.ts         Register into Claude Code / Codex
│   ├── codex-handoff.ts    Builds HandoffPackage for handoff_task / ymesh handoff
│   ├── tools.ts            Tool helpers
│   └── index.ts            Barrel
├── mount/                  Mount system (non-invasive CLI extension)
│   ├── manager.ts          mountAll / unmountAll / verifyAll
│   ├── registry.ts         Supported CLIs + strategies per CLI
│   ├── strategies.ts       mcp-toml, claude-mcp, mcp-json, skill-symlink, always-on
│   ├── types.ts            CliTarget, MountStrategy, MountResult
│   └── index.ts
├── install/                Install / release / update
│   ├── release.ts          buildRelease / installRelease / listReleases / rollbackRelease
│   ├── launcher.ts         ~/.yondermesh/bin/ymesh symlink
│   ├── updater.ts          updateFromGit (clone/pull -> build -> atomic symlink swap)
│   ├── skill-linker.ts     Symlink skills/ into each CLI's skill dir
│   ├── paths.ts            Central path resolution (resolveDataDir, resolveDbPath, ...)
│   ├── version.ts          Version comparison helpers
│   └── index.ts
├── extract/                Project history extraction
│   ├── extractor.ts        extractProject -> NDJSONL files (requirements + responses)
│   ├── index.ts            queryExtracts reads them back with filters
│   └── types.ts
├── briefing/
│   └── generator.ts        Daily digest -> ~/.yondermesh/briefings/
├── sync/
│   └── agent.ts            Cross-device sync agent (ciphertext only)
├── detect/                 CLI detection (which agents are installed locally)
│   ├── agents.ts
│   └── index.ts
├── limited/                Limited-session bridge
│   ├── session-bridge.ts
│   └── index.ts
├── sdk/                    Public SDK scaffolding for new adapters
│   ├── base-importer.ts
│   ├── base-injector.ts
│   ├── base-wrapper.ts
│   ├── scaffold.ts
│   ├── template.ts
│   ├── types.ts
│   └── index.ts
├── aider/                  Per-CLI adapter (see /reference/adapters for the full list)
│   ├── importer.ts         A-level: native importer
│   ├── wrapper.ts          B-level: launcher
│   ├── inject.ts           B-level: config snippets
│   └── index.ts            Public exports
├── amp/                    ...same pattern...
├── antigravity/
├── cass/                   (importer only)
├── chatgpt/                (extractor only — C-level)
├── claude/                 (importer only)
├── cline/
├── codebuddy/
├── codex/                  (importer only)
├── continue/
├── copilot/
├── crush/
├── cursor-ide/             (extractor only — C-level)
├── factory/
├── gemini/
├── goose/
├── hermes/
├── kimi/
├── openclaw/
├── opencode/
├── openhands/
├── pi/                     (importer + rpc.ts)
├── qwen/
├── trae-cli/
├── trae-ide/               (extractor only — C-level)
├── vibe/
└── windsurf/               (extractor only — C-level)
```

Adapter file pattern:

- `importer.ts` — **A-level**: native importer. Reads the CLI's native session files directly into `SessionStore`.
- `wrapper.ts` — **B-level**: builds the command line to invoke the wrapped CLI. A launcher, not a session reader.
- `inject.ts` — **B-level**: generates config snippets to inject into the CLI's own config (MCP JSON, agents.md, plugin hooks).
- `extractor.ts` — **C-level**: live extractor (e.g. transcript hook). Partial coverage; usually complements a B-level wrapper.
- `index.ts` — public exports for the adapter. `scripts/docs/gen-adapters.mjs` reads each `index.ts`'s header comment for the support matrix notes.

## Runtime layout

Files yondermesh writes at runtime. The data directory defaults to `~/.yondermesh/` and is overridable via `YONDERMESH_HOME` (see `/reference/config`).

```
~/.yondermesh/
├── config.yaml              User config (generated by `ymesh init`)
├── yondermesh.db            SQLite database — the only SessionStore writer target
├── daemon.pid               PID file (single-instance lock for the daemon)
├── key.pem                  E2E encryption key for sync (auto-generated on first run)
├── bin/
│   └── ymesh -> ../releases/<current>/ymesh.js   Global entry symlink
├── releases/
│   ├── current -> <version>/                      Current release symlink
│   ├── previous -> <version>/                     Previous release symlink (for rollback)
│   └── <version>/                                 Immutable release dir
│       ├── dist/                                  Compiled JS
│       ├── node_modules/                          Dependencies
│       ├── package.json
│       └── ymesh.js                               Launcher script (the symlink target)
├── briefings/                                  Daily briefing output (dated files)
├── extracts/<project-hash>/                    NDJSONL extracts (requirements.ndjsonl, responses.ndjsonl)
└── logs/                                       Daemon logs (referenced by `ymesh doctor`)
```

Platform-specific: on macOS, `ymesh service install` also writes a LaunchAgent plist to `~/Library/LaunchAgents/com.yondermesh.daemon.plist` (always under `~/Library/LaunchAgents/`, not under `YONDERMESH_HOME`).

Path resolution is centralized in `src/install/paths.ts` (`resolveDataDir`, `resolveDbPath`, `resolveBinDir`, `resolveReleasesDir`, `resolveEntrySymlink`, `resolveCurrentSymlink`, `resolvePreviousSymlink`, `resolvePidFile`, `resolveLaunchAgentPlist`). Each is read fresh on every call so `YONDERMESH_HOME` switches take effect per-invocation.

## Site layout

This documentation site is a VitePress project under `site/`. English lives at the root; Chinese is mirrored under `site/zh/`.

```
site/
├── .vitepress/
│   └── config.ts            VitePress config (locales, nav, sidebar, theme)
├── index.md                 Home page (hero + features)
├── package.json             VitePress dependency
├── reference/               English reference pages
│   ├── cli.md               Auto-generated (do not edit)
│   ├── adapters.md          Auto-generated (do not edit)
│   ├── config.md            Hand-written (this page's sibling)
│   ├── mcp-tools.md         Hand-written
│   ├── files.md             Hand-written (this page)
│   └── changelog.md         Hand-written (mirrors root CHANGELOG.md)
├── guide/                   English guide pages (hand-written)
└── zh/                      Chinese mirror
    ├── reference/
    │   ├── cli.md           Auto-generated (do not edit)
    │   ├── adapters.md      Auto-generated (do not edit)
    │   ├── config.md
    │   ├── mcp-tools.md
    │   ├── files.md
    │   └── changelog.md
    └── guide/
```

## Auto-generated vs hand-written

The doc generator pipeline lives in `scripts/docs/` and is orchestrated by `sync-all.mjs`. Run `npm run sync` inside `site/` to regenerate.

| File | Source | How to update |
|---|---|---|
| `site/reference/cli.md` | `ymesh help` output | `npm run sync` — never hand-edit |
| `site/zh/reference/cli.md` | `ymesh help` output | `npm run sync` — never hand-edit |
| `site/reference/adapters.md` | `src/*/index.ts` header comments | `npm run sync` — never hand-edit |
| `site/zh/reference/adapters.md` | `src/*/index.ts` header comments | `npm run sync` — never hand-edit |
| `site/reference/config.md` | `src/daemon/config.ts` + README | Hand-written |
| `site/reference/mcp-tools.md` | `src/mcp/server.ts` | Hand-written |
| `site/reference/files.md` | Repo tree + ARCHITECTURE.md | Hand-written |
| `site/reference/changelog.md` | Root `CHANGELOG.md` | Hand-written mirror |
| `site/guide/*.md` | — | Hand-written |
| `site/index.md` | — | Hand-written |

CI enforces no drift: `scripts/docs/check-drift.mjs` re-runs sync and fails if any auto-generated file changed; `scripts/docs/verify-links.mjs` walks every `site/**/*.md` and asserts every internal link resolves.

## Related

- `/guide/architecture` — architectural invariants and module boundaries
- `/reference/cli` — auto-generated CLI command reference
- `/reference/adapters` — auto-generated adapter support matrix
- `/reference/config` — config.yaml reference (incl. `YONDERMESH_HOME`)
