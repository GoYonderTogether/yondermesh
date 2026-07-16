---
title: 更新日志
description: yondermesh 的所有重要变更，镜像根目录 CHANGELOG.md。格式基于 Keep a Changelog；项目遵循语义化版本。
outline: [2, 3]
---

# 更新日志

本页记录本项目的所有重要变更。规范源文件是仓库根目录的 [`CHANGELOG.md`](https://github.com/GoYonderTogether/yondermesh/blob/main/CHANGELOG.md)；本页为文档站镜像。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [Unreleased] — 未发布

### Added（新增）

- 公开文档站（`site/`，VitePress），支持英文 + 中文双语。
- 文档-代码同步流水线：`scripts/docs/sync-all.mjs`、`gen-cli-docs.mjs`、`gen-adapters.mjs`。
- CI 工作流：`docs-deploy.yml`（main -> GitHub Pages）与 `docs-check.yml`（PR 漂移检测 + 链接检查）。
- `doc-sync` skill（`skills/doc-sync/SKILL.md`），用于将文档与代码对齐。
- 顶层规范文档：`ARCHITECTURE.md`、`CONTRIBUTING.md`、`AGENTS.md`。

## [0.1.0] — 首个公开版本

### Added（新增）

- **Daemon + collector + 本地 SQLite** — 自动从每个 CLI agent 采集 session 到 `~/.yondermesh/yondermesh.db`。
- **MCP server** — stdio JSON-RPC。工具：`search_sessions`、`list_active_sessions`、`get_session_handoff`、`who_is_working`、`list_active_sessions`、`search_sessions`。
- **CLI adapters** — Claude Code、Codex、Aider、Cass、Hermes、Continue、Windsurf、Gemini、Cursor、Copilot、Cline、OpenCode、Kimi、Trae 等（完整矩阵见 `/reference/adapters`）。
- **跨设备同步** — E2E 加密 relay；只有密文离开设备。
- **Mount 系统** — 非侵入式 MCP / skill / always-on 注入到每个 CLI 的配置目录。
- **安装 / release / 更新** — `ymesh install`、`ymesh update`、`ymesh rollback`，失败自动回退。
- **每日 briefing** — 跨设备 agent 活动摘要。
- **CLI** — `ymesh scan`、`sessions`、`active`、`daemon`、`mcp`、`mount`、`extract`、`handoff`、`state`、`mailbox`、`doctor` 等。
