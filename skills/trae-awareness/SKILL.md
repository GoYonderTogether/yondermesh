---
name: trae-awareness
description: >-
  Use when the user asks what tools are available, how to query sessions, what
  other agents did, what yondermesh/ymesh is, how to diagnose ymesh, or any
  question about cross-CLI session context, agent memory, or the local mesh.
  Also use when an agent running in Trae needs to discover ymesh capabilities
  (MCP tools, CLI commands, skills) before recalling prior work or handing off
  tasks. Covers Chinese triggers like "有什么工具", "怎么查 session",
  "其他 agent 在干嘛", "ymesh 是什么", "怎么诊断 ymesh", "怎么看到别的机器上的工作".
---

# yondermesh Awareness (Trae)

Trae 不读取全局指令文件（没有 always-on 注入机制），所以 yondermesh 通过这个 skill
让 Trae 在每次会话开始时就能在 skill 列表里发现 ymesh 的存在。本 skill 只做"指路"：
具体诊断走 `yondermesh-diagnose` skill，具体查询走 MCP 工具或 `ymesh` CLI。

## yondermesh 是什么

yondermesh（简称 ymesh）是一个自托管 Agent 上下文总线。它把本机所有 CLI agent
（Claude Code、Codex、Cursor、Gemini、Windsurf、Trae、Continue 等）的 session 自动
采集到本地 SQLite，并提供跨设备 E2E 加密同步。任何支持 MCP 的 agent 都能查询其他
agent 的工作上下文，实现跨设备/跨 CLI 的上下文延续与任务交接。

## 可用能力

### MCP 工具（如果 MCP server 已挂载到当前 CLI）

注意：Trae 的 MCP 通过 IDE UI 配置，不是文件可挂。如果当前 Trae 没配 ymesh MCP
server，请引导用户在 Trae 设置里手动添加，或改用下面的 CLI 命令。

- `recall_recent_work` — 查询最近 session（跨设备 / 跨 CLI）
- `whats_on_device` — 查看某台设备的项目状态
- `handoff_task` — 把任务委托给另一个 agent

### CLI 命令

```bash
ymesh help                          # 查看所有命令
ymesh status                        # daemon / 数据库 / 适配器状态
ymesh sessions --json --limit 10    # 看最近 10 条 session
ymesh query recent                  # 跨设备查最近工作
ymesh doctor                        # 系统健康检查
ymesh mount                         # 把 ymesh 挂到各 CLI（含 Trae 的 skill 目录）
```

### Skill

- `yondermesh-diagnose` — 系统诊断（数据库、daemon、日志、适配器覆盖）。在 Trae 里
  用户问"ymesh 怎么了""为什么没数据""daemon 挂了"时，优先调用这个 skill。

## 常见触发场景

| 用户说 | 你应该做 |
|---|---|
| "有什么工具" / "你能做什么" | 列出上面的 MCP 工具 + CLI 命令 |
| "怎么查 session" / "我之前做过什么" | `ymesh sessions --json --limit 10` 或 MCP `recall_recent_work` |
| "其他 agent 在干嘛" / "别的机器上呢" | MCP `whats_on_device` 或 `ymesh query recent` |
| "ymesh 是什么" / "ymesh 干嘛的" | 念上面的"yondermesh 是什么"段落 |
| "怎么诊断 ymesh" / "ymesh 有问题" | 调用 `yondermesh-diagnose` skill |
| "怎么挂到 trae" | `ymesh mount`；Trae 走 skill-symlink 到 `~/.trae[-cn]/skills/` |

## Trae 特殊说明

- Trae 有四个变体：IDE 国际版、IDE 中文版、Work 国际版、Work 中文版。
- 物理上只有 2 个目录：`~/.trae`（国际版）和 `~/.trae-cn`（中文版）。
- 每个目录下 IDE 和 Work 共享用户级 skills 目录，所以挂 2 个 CliTarget
  （`trae` + `trae-cn`）即覆盖全部 4 个变体。
- Trae 不支持 always-on 注入（不读全局指令文件），所以用本 skill 替代 awareness 段落。
- Trae 的 MCP 通过 IDE UI 配置，不能通过文件挂载（无 mcp-json 能力）。

## 不要做的事

- 不要假设 Trae 读了 `project_rules.md` 之类的全局指令文件——它不读。
- 不要试图给 Trae 写 `mcp.json`——Trae 的 MCP 配置在 IDE UI 里。
- 做诊断时不要重复 `yondermesh-diagnose` 已有的内容，直接调用那个 skill。
