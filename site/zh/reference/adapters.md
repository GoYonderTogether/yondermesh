---
title: CLI 适配器
description: yondermesh 可采集 session 的 CLI agent 支持矩阵。
outline: [2, 3]
---

> **自动生成** 自 `src/*/`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。

yondermesh 直接读取各 CLI agent 的原生 session 格式。覆盖等级：

- **A** — 原生 importer：直接读取 CLI 原生 session 文件（JSONL / session DB）
- **B** — Wrapper / markdown importer：解析导出的 markdown、git log 或 wrapper 输出
- **C** — 仅 extractor：部分覆盖（如实时 transcript hook），尚未支持完整历史导入

## 支持矩阵

| CLI | 覆盖等级 | 适配器目录 | 说明 |
|---|---|---|---|
| `aider` | A | [`src/aider/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/aider) | — |
| `amp` | A | [`src/amp/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/amp) | — |
| `antigravity` | A | [`src/antigravity/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/antigravity) | — |
| `cass` | A | [`src/cass/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/cass) | — |
| `claude` | A | [`src/claude/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/claude) | — |
| `cline` | A | [`src/cline/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/cline) | — |
| `codebuddy` | A | [`src/codebuddy/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/codebuddy) | — |
| `codex` | A | [`src/codex/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/codex) | — |
| `continue` | A | [`src/continue/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/continue) | — |
| `copilot` | A | [`src/copilot/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/copilot) | — |
| `crush` | A | [`src/crush/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/crush) | — |
| `gemini` | A | [`src/gemini/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/gemini) | 原生 adapter |
| `goose` | A | [`src/goose/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/goose) | — |
| `hermes` | A | [`src/hermes/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/hermes) | — |
| `kimi` | A | [`src/kimi/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/kimi) | — |
| `openclaw` | A | [`src/openclaw/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/openclaw) | — |
| `opencode` | A | [`src/opencode/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/opencode) | — |
| `openhands` | A | [`src/openhands/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/openhands) | — |
| `pi` | A | [`src/pi/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/pi) | Importer：JSONL v3 解析 + entry 树保留 + 三 flavor 探测 |
| `qwen` | A | [`src/qwen/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/qwen) | 原生 adapter |
| `trae-cli` | A | [`src/trae-cli/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/trae-cli) | — |
| `vibe` | A | [`src/vibe/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/vibe) | — |
| `chatgpt` | C | [`src/chatgpt/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/chatgpt) | — |
| `cursor-ide` | C | [`src/cursor-ide/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/cursor-ide) | — |
| `trae-ide` | C | [`src/trae-ide/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/trae-ide) | — |
| `windsurf` | C | [`src/windsurf/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/windsurf) | — |
| `detect` | ? | [`src/detect/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/detect) | — |
| `mailbox` | ? | [`src/mailbox/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/mailbox) | — |
| `sdk` | ? | [`src/sdk/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/sdk) | ─── 公共类型（再导出供单点 import） ─────────────────────────────────── |
| `trigger` | ? | [`src/trigger/`](https://github.com/GoYonderTogether/yondermesh/tree/main/src/trigger) | — |

## 新增适配器

1. 新建 `src/<cli-name>/`，包含 `index.ts` 导出 `Importer` 类。
2. 在 `src/bin/ymesh.ts` 的 `cmdScan()` 中注册，让 `ymesh scan` 调用它。
3. 在 `site/` 目录运行 `npm run sync` —— 本页会自动更新。
4. 在 `site/` 目录运行 `npm run check-drift` 验证其他文档无漂移。
