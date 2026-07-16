# yondermesh

> **自托管 Agent 上下文总线。** 一个 daemon，一个 MCP server，零侵入 —— 把所有设备、所有 CLI 的 Agent 聚合成一个有共享工作面的整体。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docs](https://img.shields.io/badge/docs-online-blue.svg)](https://goyondertogether.github.io/yondermesh/)

[English](README.md) | **[简体中文](README.zh-CN.md)**

> **状态标签：** `shipped` = 已实现且有测试 · `preview` = 代码已存在但未发版 · `planned` = 未实现（仅设计）。

## 为什么是 yondermesh

你不会只用一个 AI 编码 agent。你同时用 Claude Code、Codex、Aider、Gemini CLI、Cursor、Windsurf、Trae、Continue、OpenCode、Hermes，再加上十几个其它的 —— 散落在笔记本、台式机、服务器上。每一个都是一座孤岛。上下文在 session 边界处消亡。笔记本上的 Agent A 完全不知道台式机上的 Agent B 刚做了什么。你只能在他们之间复制粘贴摘要，给每个新 session 重新解释项目背景，并祈祷别丢什么重要信息。

这种碎片化，是你每次切换 CLI 或机器时都在默默支付的税。yondermesh 就是终结这件事的那个中枢。

## 它是什么

**yondermesh 是一个自托管的 Agent 上下文总线 —— 一个 daemon，一个 MCP server，零侵入。** 它把每台设备上每个 CLI 的 Agent 聚合成一个整体：一个有跨平台记忆、跨设备实时感知、能在不丢失任何上下文的情况下接力工作的共享工作面。

- **采集（Collect）** `shipped` —— 把每台设备上每个 CLI 的 session 全部收进一个本地 SQLite。你的 Agent 不再是孤岛，而是聚合成一个有共享工作面的整体。
- **同步（Sync）** `planned` —— 通过自托管 relay 做端到端加密跨设备同步。尚未实现；sync 代码路径是 TODO 空壳。
- **查询（Query）** `shipped` —— 任何 agent 通过 MCP 工具查询其他 agent 的上下文。拓扑感知、来源感知、项目感知。
- **接力（Hand off）** `shipped` —— Agent A 从 Agent B 停下的地方继续，即使换了机器。session 不再在边界处消亡，而是成为一条连续的工作流。
- **同步注入（Send）** `preview` —— 向任意已接入的 CLI agent 实时发一条 user message 并同步拿到回复。23 个 CLI（Claude Code 和 Codex 尚未接入 — planned）。6 种通道（cli-spawn / stdin / http-api / ws-rpc / tmux / applescript），3 种模式（停止 / 运行中 / 新建）。即使对方 agent 没配 model，至少也能返回错误消息，而不是沉默。

## 快速开始

```bash
# 安装
npm install -g yondermesh

# 启动 daemon（自动创建 ~/.yondermesh/，自动扫描本机所有 agent session）
ymesh daemon

# 检查发现了什么
ymesh status
ymesh agents
ymesh sessions --limit 10
ymesh active   # 谁正在干活
```

把 yondermesh 通过 MCP 接入你的 agent：

```bash
# 注册 MCP server 到 Claude Code 和 Codex
ymesh mcp register

# 挂载 skills + MCP 到所有检测到的 CLI
ymesh mount all
```

或手动添加到你的 agent 配置（`.claude/claude_desktop_config.json` 或等价文件）：

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "ymesh",
      "args": ["mcp"]
    }
  }
}
```

现在任何支持 MCP 的 agent 都可以调用 `who_is_working`、`search_sessions`、`get_session_handoff`、`yondermesh_send` 等工具。

### 向任意 agent 提问，拿回回复

```bash
# 向一个已接入的 agent 注入一个问题，并同步拿到答案
ymesh send --cli hermes --mode new --message "用一句话总结当前分支最新一次 commit。"

# 恢复一个已停止的 session，追问一句
ymesh send --cli opencode --session <id> --mode stopped --message "再对上一次 commit 做同样的事。"
```

`ymesh send`（或 `yondermesh_send` MCP 工具）是同步消息投递的统一入口。它为目标 CLI 选对通道、投递消息、清洗回复、把整条线程写进审计日志 —— 全部一次调用完成。

## 核心特性

- **27 个 CLI 适配器，聚合成一个整体** —— 读取原生 session 格式，覆盖 Claude Code、Codex、Hermes、Gemini、Goose、Aider、Amp、Factory、Vibe、CodeBuddy、Trae CLI、OpenCode、Qwen、OpenHands、Kimi、OpenClaw、Pi、Copilot、Crush、Cline、Continue、Antigravity，以及 IDE 类（Trae IDE、Windsurf、Cursor IDE、ChatGPT）。无需修改 CLI。完整矩阵见：[adapters reference](https://goyondertogether.github.io/yondermesh/zh/reference/adapters)。
- **MCP server** —— 通过 stdio JSON-RPC 暴露工具；任何支持 MCP 的 agent 即可获得跨设备上下文、接力、以及同步注入能力。
- **跨设备同步** `planned` —— 端到端加密 relay 设计已存在；sync 代码路径是 TODO 空壳，尚未可用。
- **Mount 系统** `shipped` —— 非侵入式地把 MCP server、skill、always-on 上下文安装到每个 CLI 自己的配置目录。
- **Session 接力** `shipped` —— 提取浓缩 handoff 包（摘要 + 近期消息 + 任务计划），传给另一个 agent。
- **同步注入（Mailbox v3）** `preview` —— `ymesh send` / `yondermesh_send` 把 user message 投递到任意已接入的 CLI 并返回清洗后的回复。6 种触发通道，3 种模式（停止 / 运行中 / 新建，新建模式可选 `model` + `effort`）。失败永不沉默：未知 CLI、未配 model、上游 API 限流，都会以文本形式回到 response 里。
- **每日简报** `planned` —— 活动摘要设计已存在；briefing generator 是 TODO 空壳，尚未可用。
- **无 UI、无云锁定、无模型代理、无 agent 修改。**

## 架构

```
┌─────────────────────────────────────────────────────┐
│  设备 A (macOS)                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ClaudeCode│  │  Codex   │  │  yondermesh daemon│  │
│  │  JSONL   │  │  session │  │  ┌─────────────┐  │  │
│  └────┬─────┘  └────┬─────┘  │  │  collector   │  │  │
│       │              │        │  │  SQLite store│  │  │
│       └──────────────┘        │  │  MCP server  │  │  │
│                                │  │  sync agent  │  │  │
│                                │  │  trigger     │  │  │
│                                │  └──────┬──────┘  │  │
│                                └─────────┼─────────┘  │
│                                          │            │
└──────────────────────────────────────────┼────────────┘
                                           │ 端到端加密
                              ┌────────────┴────────────┐
                              │     自托管 relay        │
                              │    （仅密文传输）        │
                              └────────────┬────────────┘
                                           │
┌──────────────────────────────────────────┼────────────┐
│  设备 B (Windows)                        │            │
│  ┌──────────┐  ┌──────────┐  ┌───────────┴──────────┐ │
│  │  Codex   │  │  Aider   │  │  yondermesh daemon   │ │
│  │  session │  │  git log │  │  查询设备 A 的上下文  │ │
│  └──────────┘  └──────────┘  └──────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

四个平面（三个已交付，一个 planned）：

| 平面 | 数据流 | 状态 |
|---|---|---|
| **本地** | CLI 原生文件 → 适配器 → SessionStore (SQLite) → MCP server (stdio) | `shipped` |
| **同步** | SessionStore → relay agent → 自托管 relay（仅密文）→ 对端设备 | `planned` |
| **挂载** | ymesh skills / MCP 配置 → CLI 自己的配置目录（`~/.claude/`、`~/.codex/` 等） | `shipped` |
| **触发** | MailboxCore → TriggerAdapter（cli-spawn / stdin / http-api / ws-rpc / tmux / applescript）→ 目标 CLI → ReplyAdapter → 审计日志 | `preview` |

完整代码地图和架构不变式见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## CLI 覆盖

yondermesh 读取每个 CLI agent 的原生 session 格式，并通过触发层向其中 23 个 CLI 同步注入消息。各 CLI 的挂载策略：

| CLI | MCP 挂载 | Skill 挂载 | Always-on 注入 |
|---|---|---|---|
| codex | mcp-toml (`~/.codex/config.toml`) | skill-symlink (`~/.codex/skills/`) | `~/.codex/AGENTS.md` |
| claude-code | claude-mcp (`claude mcp add`) | — | `~/.claude/CLAUDE.md` |
| cursor | mcp-json (`~/.cursor/mcp.json`) | skill-symlink (`~/.cursor/skills/`) | `~/.cursorrules` |
| gemini | mcp-json (`~/.gemini/settings.json`) | — | `~/.gemini/GEMINI.md` |
| windsurf | mcp-json (`~/.windsurf/mcp_config.json`) | skill-symlink (`~/.windsurf/skills/`) | `~/.windsurfrules` |
| trae | — | skill-symlink (`~/.trae/skills/`) | — |
| trae-cn | — | skill-symlink (`~/.trae-cn/skills/`) | — |
| continue | — | skill-symlink (`~/.continue/skills/`) | — |

完整适配器矩阵（27 个 CLI，覆盖等级 A/B/C）：[文档/reference/adapters](https://goyondertogether.github.io/yondermesh/zh/reference/adapters)

## 配置

> `planned` —— daemon 目前**不解析** `config.yaml`。它使用 `src/daemon/config.ts` 中定义的内置默认值。下表是当前实际生效的配置项。

| 设置 | 默认值 | 覆盖方式 |
|---|---|---|
| 数据目录 | `~/.yondermesh` | `YONDERMESH_HOME=/path/to/dir` |
| SQLite DB | `<数据目录>/yondermesh.db` | `--db <path>` CLI 参数 |
| 全量扫描间隔 | `60000` ms（1 分钟） | — |
| 监听防抖 | `1000` ms | — |
| 自动挂载扩展 | `true` | — |
| 跳过 cass 适配器 | `false` | — |
| 跳过 Claude 实时监听 | `false` | — |
| 跳过 Codex 实时监听 | `false` | — |

包含 `devices`、`sync`、`mcp`、`briefing` 段的 `config.yaml` 是设计目标，当前不可用。

## 文档

完整文档：**https://goyondertogether.github.io/yondermesh/zh/**

- [快速上手](https://goyondertogether.github.io/yondermesh/zh/guide/quickstart)
- [架构](https://goyondertogether.github.io/yondermesh/zh/guide/architecture)
- [CLI 命令参考](https://goyondertogether.github.io/yondermesh/zh/reference/cli)
- [MCP 工具](https://goyondertogether.github.io/yondermesh/zh/reference/mcp-tools)
- [适配器矩阵](https://goyondertogether.github.io/yondermesh/zh/reference/adapters)
- [配置文件](https://goyondertogether.github.io/yondermesh/zh/reference/config)

## 不做什么

- **没有 UI** —— 配置文件驱动，daemon 无头运行
- **没有云锁定** —— 完全可自托管；云 relay 只是可选便利
- **没有模型代理** —— 永远不碰你的 API key
- **没有 agent 修改** —— 读取原生文件，暴露 MCP，仅此而已

## 路线图

- [x] **M1** —— daemon + collector + 本地 SQLite + MCP 查询工具
- [x] **M2** —— session 接力（`get_session_handoff`、`ymesh handoff`）
- [x] **Mailbox v3** —— 同步注入（`ymesh send` / `yondermesh_send`）；23 个 CLI，6 种触发通道，3 种模式
- [ ] **M3** —— 企业版：审计日志、RBAC、session 回放、合规报告
- `planned` **跨设备同步** —— 端到端加密 relay；sync 代码路径是 TODO 空壳
- `planned` **每日简报** —— 活动摘要；generator 是 TODO 空壳
- `planned` **config.yaml 解析** —— daemon 当前仅使用内置默认值

## 贡献

欢迎贡献。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目遵循 **docs-as-code** 纪律：每次代码改动必须在同一个 commit 中更新对应文档。doc-sync skill（`skills/doc-sync/`）自动化执行审计。

## 安全

见 [SECURITY.md](SECURITY.md)。威胁模型摘要：本地 SQLite（无静态加密）、同步 relay（仅密文）、MCP stdio（本地）、mount（写入 CLI 配置目录，永不修改二进制文件）、trigger（仅 spawn / 注入本地 CLI 进程，无远程代码执行）。

## 许可证

MIT —— 由 [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether) 出品
