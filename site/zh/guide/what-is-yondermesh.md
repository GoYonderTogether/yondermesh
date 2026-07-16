---
title: yondermesh 是什么？
description: 一个自托管的 Agent 上下文总线 —— 把所有设备、所有 CLI 的 Agent 聚合成一个有共享工作面的整体：共享上下文、互相查询、接力任务、跨设备跨 CLI 同步注入消息。
outline: [2, 3]
---

# yondermesh 是什么？

yondermesh 是一个自托管的 **Agent 上下文总线（Agent Context Bus）**。它在每台设备上
运行一个守护进程，将所有 CLI 编程 Agent 的 session 自动采集到本地 SQLite 存储中，并对外
暴露一个 MCP（Model Context Protocol）服务器供任何支持 MCP 的 Agent 查询。结果是：每台
设备上每个 CLI 的 Agent 不再是孤岛，而是聚合成一个有共享工作面的整体 —— 跨平台记忆、
跨设备实时感知、连续接力。

这是 Agent 时代的协作中枢。不是又一个 CLI，不是又一个模型，不是又一片云。只是一块刻意
保持很小的基础设施，让你已经在用的那些 Agent 作为一个整体协同工作。

## 问题：Agent 是孤岛

如果你在多台机器上使用多个 AI 编程 Agent —— Claude Code、Codex、Aider、Gemini CLI、
Cursor、Windsurf、Trae、Continue、OpenCode、Hermes，再加上十几个其它的 —— 你多半已经
体会过这些痛点：

- **上下文在 session 边界处消亡。** 一个 session 结束后，Agent 学到的所有东西都消失了。
  下一个 session（或另一台设备上的另一个 Agent）只能从零开始。
- **Agent 之间互不可见。** 你笔记本上的 Codex session 完全不知道你台式机上的 Claude Code
  session 刚做了什么。没有一个共享的工作面。
- **交接靠手动。** 要把工作从一个 Agent 传给另一个，你得复制粘贴摘要、重新解释项目背景，
  还得祈祷别丢什么重要信息。
- **没有跨设备可见性。** 你无法问一句"我的 Agent 们今天都做了什么？"，除非 ssh 到每台
  机器上、逐个 CLI 读它们各自的日志。
- **没法对话回去。** 即使一个 Agent 知道另一个正在运行，它也无法向对方提一个问题并拿到
  回复。mesh 默认是只读的；闭环从来没合上。

每个 CLI 都用自己的格式写 session —— JSONL、session 数据库、git log、transcript hook。
每台设备都是隔离的。最终结果是碎片化、有损、且作为一个整体根本无法查询。这就是你每次切
换 CLI 或机器时默默支付的税。

## 解决方案：一个守护进程、一个 MCP 服务器、零侵入

yondermesh 用一个刻意保持很小的表面积来解决这个问题：

- **一个守护进程** —— `ymesh daemon` 无头运行，监听原生 session 文件，写入
  `~/.yondermesh/yondermesh.db`。它只读原生文件，从不修改它所读取的 CLI。
- **一个 MCP 服务器** —— `ymesh mcp` 通过 stdio JSON-RPC 通信。任何支持 MCP 的 CLI
  （Claude Code、Codex、Cursor、Gemini、Windsurf 等）都能调用同一组工具，无需为每个
  CLI 写胶水代码。
- **零侵入** —— 没有 UI、没有云锁定、不做模型代理、不改 Agent。yondermesh 只读取 CLI
  已经写下的内容，然后通过 MCP 暴露出去。这就是全部表面积。

四个互不污染的平面：

```
Local plane     CLI 原生文件 -> adapter -> SessionStore (SQLite) -> MCP server (stdio)
Sync plane      SessionStore -> relay agent -> 自托管 relay（仅密文）-> 对端设备
Mount plane     ymesh skills / MCP 配置 -> CLI 自己的配置目录 (~/.claude/, ~/.codex/, ...)
Trigger plane   MailboxCore -> TriggerAdapter -> 目标 CLI -> ReplyAdapter -> 审计日志
```

## 核心能力

### 采集（Collect）

把每台设备上每个 CLI 的 session 全部收进一个本地 SQLite。yondermesh 内置了多个
adapter，直接读取每个 CLI 的原生格式 —— Claude Code JSONL、Codex session 数据库、
Aider git log、Continue session 等等。无需修改 CLI；守护进程读取的是 CLI 已经写下的文件。
你的 Agent 不再是孤岛，而是聚合成一个有共享工作面的整体。

每个 adapter 有一个覆盖等级：

- **A** —— 原生 importer：直接读取 CLI 的原生 session 文件（JSONL / session DB）写入存储。
- **B** —— Wrapper / markdown importer：解析导出的 markdown、git log 或 wrapper 输出。
- **C** —— 仅 Extractor：部分覆盖，例如实时 transcript hook。

守护进程生命周期很简单：`启动 -> 扫描一次 -> 监听（fs 事件）-> 定时 reconcile -> 空闲`。
它只读原生文件，从不修改。完整的支持矩阵见 [CLI 适配器参考](/zh/reference/adapters)。

### 同步（Sync）

通过自托管 relay 进行跨设备同步。session 在离开设备之前用本地密钥进行端到端加密 ——
relay 只看到密文。云 relay 是可选的便利设施；你可以自托管 relay，永远不让明文离开你的
机器。

同步 agent 从本地 `SessionStore` 读取新 session，用本地密钥加密，将密文推送到 relay，
并拉取对端更新后在本地解密。relay 是一根"哑管道"：它永远不持有解密密钥。结果是跨平台
记忆，但不锁定云。

### 查询（Query）

任何支持 MCP 的 Agent 都能通过一小组 MCP 工具查询其他 Agent 的上下文：

- `recall_recent_work` —— 查询整个 mesh 中的近期 session。
- `whats_on_device` —— 检查某台远程设备的项目状态。
- `who_is_working` —— 查看当前哪些 Agent 正在活动。
- `list_active_sessions` —— 枚举活跃 session。
- `search_sessions` —— 对已采集 session 做全文搜索。
- `handoff_task` —— 将任务委派给另一个 Agent。

由于存储是[拓扑感知](/zh/guide/sessions)的（root / subagent / sidechain）、
源感知的（`claude`、`codex`、`cass`、`hermes`、`continue`、`windsurf`、...）、
以及项目感知的（`cwd`、`projectPath`），查询返回的是结构化结果，而非原始日志。
默认情况下，不显式请求 subagent 的查询只返回 root session。

### 接力（Hand off）

Agent A 从 Agent B 停下的地方继续，即使换了机器。session 不再在边界处消亡，而是成为
一条连续的工作流。`ymesh handoff <session-id>` 命令会构建一个浓缩的 `HandoffPackage` ——
摘要加上近期工具调用加上任务计划 —— 可以喂给另一个 Agent 的上下文窗口。这就是把孤立
session 变成跨设备连续工作流的桥梁。

同一机制也驱动了 `handoff_task` MCP 工具，因此 Agent 可以在无需人工介入的情况下以编程
方式请求交接包。

### 同步注入（Send）

向任意已接入的 CLI agent 实时发一条 user message 并同步拿到回复。这是最新加的能力，它
合上了之前版本留下的那个口子：在 `send` 出现之前，mesh 是只读的 —— Agent 互相能看见，
但没法对话回去。现在可以了。

`ymesh send`（CLI）和 `yondermesh_send`（MCP 工具）是统一入口。它们为目标 CLI 选对通
道、投递消息、清洗回复、把整条线程写进审计日志 —— 全部一次调用完成。

- **28 个 CLI 全打通** —— claude、codex、hermes、gemini、goose、aider、amp、factory、
  vibe、codebuddy、trae-cli、opencode、qwen、openhands、kimi、openclaw、pi、copilot、
  crush、cline、continue、antigravity，加上 IDE 类（trae-ide、windsurf、cursor-ide、
  chatgpt）。
- **6 种触发通道** —— `cli-spawn`（spawn 新进程）、`stdin`（向运行中 session 的 stdin
  写入）、`http-api`（POST 到 CLI 的 HTTP API）、`ws-rpc`（WebSocket / JSON-RPC）、
  `tmux`（向 tmux pane send-keys）、`applescript`（macOS 上对 IDE 类 CLI 发 keystroke）。
- **3 种触发模式** —— `stopped`（用 `--resume` 加 message flag 恢复已停止的 session）、
  `running`（向运行中 session 原地注入）、`new`（创建新 session，可选 `model` 和
  `effort`）。
- **失败永不沉默。** 即使对方 agent 没配 model、上游 API 限流、CLI 非零退出，
  `send()` 都会带着 `delivered` / `error` / `response` 返回，而不是 hang 住。CLI 自己
  的错误文本会出现在 `response` 里，让调用方"看见"发生了什么。

正是这一点，把 yondermesh 从一个被动的可观测性平面，变成了一个主动的协作平面。机器 A
上的 Agent 现在可以向机器 B 上的 Agent 提一个问题并拿到答案 —— 同步地、一次往返、完整
线程保留在审计日志里。

## 它不做的事

yondermesh 的范围刻意收窄。以下是非目标，是设计上的选择，而非当前限制：

- **没有 UI。** 配置由文件驱动；守护进程无头运行。这个文档站点是给人阅读 yondermesh 相关
  信息的，不是用来日常操作它的。
- **没有云锁定。** 完全可自托管。同步 relay 可以自托管；官方云 relay 是可选的便利设施，
  永远看不到明文。
- **不做模型代理。** yondermesh 永远不碰你的 API 密钥。CLI 运行模型；yondermesh 只读取
  CLI 写下的内容。
- **不改 Agent。** adapter 读取原生文件；mount 写入各 CLI 自己的配置目录，但从不打补丁
  修改 CLI 二进制文件或其 session 写入器。

这些边界是[架构不变量](/zh/guide/architecture)，由源码中的模块边界强制执行，而非仅仅是
愿景性的指导原则。

## 关于 Mount 系统

yondermesh 通过一个非侵入式的 **mount 系统**将自己的能力延伸到其他 CLI。每个 mount 把一个
yondermesh 扩展（MCP 服务器 / skill / always-on 段落）安装到 CLI 自己的配置目录中 ——
例如 `~/.claude/claude_desktop_config.json`、`~/.codex/config.toml`、
`~/.cursor/mcp.json` 或 `~/.gemini/settings.json`。

mount 系统从不引用单个 adapter 的内部实现。mount 策略由 CLI 的配置位置驱动，而非由 adapter
内部驱动，这让两个关注点保持干净的分离。详见 [Mount 系统指南](/zh/guide/mount)。

## 接下来去哪

- [快速上手](/zh/guide/quickstart)——安装 yondermesh 并在五分钟内完成第一次扫描。
- [安装](/zh/guide/installation)——npm 安装、从源码构建、release 管理以及 macOS
  LaunchAgent 服务。
- [架构](/zh/guide/architecture)——四个平面（local / sync / mount / trigger）、代码地图、
  以及保持它们干净的不变量。
- [CLI 命令](/zh/reference/cli)——完整的命令参考，由 `ymesh help` 自动生成。
- [CLI 适配器](/zh/reference/adapters)——yondermesh 能采集 session 的所有 CLI Agent 的
  支持矩阵。
