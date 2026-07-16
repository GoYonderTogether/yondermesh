---
title: Changelog
description: All notable changes to yondermesh, mirroring the root CHANGELOG.md. Format based on Keep a Changelog; project adheres to Semantic Versioning.
outline: [2, 3]
---

# Changelog

All notable changes to this project are documented on this page. The canonical source file is [`CHANGELOG.md`](https://github.com/GoYonderTogether/yondermesh/blob/main/CHANGELOG.md) at the repository root; this page mirrors it for the docs site.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public documentation site (`site/`, VitePress) with English + Chinese locales.
- Doc-code sync pipeline: `scripts/docs/sync-all.mjs`, `gen-cli-docs.mjs`, `gen-adapters.mjs`.
- CI workflows: `docs-deploy.yml` (main -> GitHub Pages) and `docs-check.yml` (PR drift + link check).
- `doc-sync` skill (`skills/doc-sync/SKILL.md`) for reconciling docs with code.
- Top-level canonical docs: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`.

## [0.1.0] — initial public release

### Added

- **Daemon + collector + local SQLite** — auto-harvests sessions from every CLI agent into `~/.yondermesh/yondermesh.db`.
- **MCP server** — stdio JSON-RPC. Tools: `search_sessions`, `list_active_sessions`, `get_session_handoff`, `who_is_working`, `list_active_sessions`, `search_sessions`.
- **CLI adapters** — Claude Code, Codex, Aider, Cass, Hermes, Continue, Windsurf, Gemini, Cursor, Copilot, Cline, OpenCode, Kimi, Trae, and more (see `/reference/adapters` for the full matrix).
- **Cross-device sync** — E2E-encrypted relay; ciphertext only leaves the device.
- **Mount system** — non-invasive MCP / skill / always-on injection into each CLI's config dir.
- **Install / release / update** — `ymesh install`, `ymesh update`, `ymesh rollback`, with auto-rollback on failure.
- **Daily briefing** — digest of agent activity across devices.
- **CLI** — `ymesh scan`, `sessions`, `active`, `daemon`, `mcp`, `mount`, `extract`, `handoff`, `state`, `mailbox`, `doctor`, etc.
