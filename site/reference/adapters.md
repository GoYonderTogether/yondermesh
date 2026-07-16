---
title: CLI Adapters
description: Support matrix for CLI agents that yondermesh can harvest sessions from.
outline: [2, 3]
---

> **Auto-generated** from `src/*/`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.

yondermesh reads native session formats from each supported CLI agent. Coverage levels:

- **A** — Native importer: reads the CLI's native session files (JSONL / session DB) directly
- **B** — Wrapper / markdown importer: parses exported markdown, git log, or wrapper output
- **C** — Extractor only: partial coverage (e.g. live transcript hook); no full historical import yet

## Support Matrix

| CLI | Coverage | Adapter dir | Notes |
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

## Adding a New Adapter

1. Create `src/<cli-name>/` with `index.ts` exporting an `Importer` class.
2. Add the adapter to `src/bin/ymesh.ts` `cmdScan()` so `ymesh scan` invokes it.
3. Re-run `npm run sync` in `site/` — this page updates automatically.
4. Run `npm run check-drift` in `site/` to verify no other docs drifted.
