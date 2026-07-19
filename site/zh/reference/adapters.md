---
title: CLI 适配器
description: yondermesh 可采集 session 的 CLI agent 支持矩阵。
outline: [2, 3]
---

> **自动生成** 自 `src/adapters/registry.ts`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。

## 覆盖概览

| 口径 | 数量 | 含义 |
|---|---|---|
| 注册总数 | **32** | 注册表中的 CLI 适配器总数 |
| 采集 | **27** | 有 session importer（`ymesh scan`）|
| 可挂载 | **30** | 可接收 MCP / skill / plugin 挂载 |
| send 可达 | **26** | 可被同步 `send` 触达（有非空触发通道）|
| 覆盖 A / B / C | **22 / 9 / 1** | 原生 / wrapper / 仅 extractor |

覆盖等级：

- **A** — 原生 importer：直接读取 CLI 原生 session 文件（JSONL / session DB）
- **B** — Wrapper / markdown importer：解析导出的 markdown、git log 或 wrapper 输出
- **C** — 仅 extractor：部分覆盖（如实时 transcript hook），尚未支持完整历史导入

## 支持矩阵

| CLI | 覆盖等级 | send | 适配器目录 | 说明 |
|---|---|---|---|---|
| `antigravity` | A | ✅ | [`src/antigravity/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/antigravity) | — |
| `cass` | A | — | [`src/cass/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/cass) | — |
| `claude-code` | A | ✅ | [`src/claude/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/claude) | — |
| `cline` | A | ✅ | [`src/cline/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/cline) | — |
| `codebuddy` | A | ✅ | [`src/codebuddy/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/codebuddy) | — |
| `codex` | A | ✅ | [`src/codex/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/codex) | — |
| `continue` | A | ✅ | [`src/continue/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/continue) | — |
| `copilot` | A | ✅ | [`src/copilot/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/copilot) | — |
| `crush` | A | ✅ | [`src/crush/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/crush) | — |
| `factory` | A | ✅ | [`src/factory/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/factory) | — |
| `gemini` | A | ✅ | [`src/gemini/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/gemini) | 原生 adapter |
| `goose` | A | ✅ | [`src/goose/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/goose) | — |
| `gsd-pi` | A | — | — | — |
| `hermes` | A | ✅ | [`src/hermes/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/hermes) | — |
| `kimi` | A | ✅ | [`src/kimi/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/kimi) | — |
| `omp` | A | — | — | — |
| `openclaw` | A | ✅ | [`src/openclaw/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/openclaw) | — |
| `opencode` | A | ✅ | [`src/opencode/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/opencode) | — |
| `openhands` | A | ✅ | [`src/openhands/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/openhands) | — |
| `pi` | A | ✅ | [`src/pi/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/pi) | Importer：JSONL v3 解析 + entry 树保留 + 三 flavor 探测 |
| `qwen` | A | ✅ | [`src/qwen/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/qwen) | 原生 adapter |
| `vibe` | A | ✅ | [`src/vibe/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/vibe) | — |
| `aider` | B | ✅ | [`src/aider/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/aider) | — |
| `amp` | B | ✅ | [`src/amp/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/amp) | — |
| `cursor` | B | — | — | — |
| `cursor-ide` | B | ✅ | [`src/cursor-ide/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/cursor-ide) | — |
| `trae` | B | — | — | — |
| `trae-cli` | B | ✅ | [`src/trae-cli/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/trae-cli) | — |
| `trae-cn` | B | — | — | — |
| `trae-ide` | B | ✅ | [`src/trae-ide/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/trae-ide) | — |
| `windsurf` | B | ✅ | [`src/windsurf/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/windsurf) | — |
| `chatgpt` | C | ✅ | [`src/chatgpt/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/chatgpt) | — |

## 新增适配器

1. 新建 `src/<cli-name>/`，包含 `index.ts` 导出 `Importer` 类。
2. 在 `src/bin/ymesh.ts` 的 `cmdScan()` 中注册，让 `ymesh scan` 调用它。
3. 在 `site/` 目录运行 `npm run sync` —— 本页会自动更新。
4. 在 `site/` 目录运行 `npm run check-drift` 验证其他文档无漂移。
