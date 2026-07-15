# yondermesh

> 自托管 Agent 上下文总线 —— 让你的 AI agent 互相看见、互相查询、跨设备跨 CLI 接力任务。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docs](https://img.shields.io/badge/docs-online-blue.svg)](https://goyondertogether.github.io/yondermesh/)

[English](README.md) | **[简体中文](README.zh-CN.md)**

---

## 问题是什么？

你同时使用多个 AI 编码 agent —— Claude Code、Codex、Aider、Gemini CLI、Cursor、Windsurf、Trae、Continue —— 分布在多台机器上。每个 agent 都是一座孤岛，上下文在 session 边界处消亡。你笔记本上的 Agent A 完全不知道你桌面上的 Agent B 刚做了什么。

## 怎么解决

**yondermesh 来解决。** 一个 daemon，一个 MCP server，零侵入。

- **采集** —— 自动从每台设备上的每个 CLI agent 收割 session 到本地 SQLite
- **同步** —— 通过自托管 relay 做端到端加密跨设备同步（只有密文离开你的机器）
- **查询** —— 任何 agent 通过 MCP 工具查询其他 agent 的上下文
- **接力** —— Agent A 从 Agent B 停下的地方继续，即使在不同机器上

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

现在任何支持 MCP 的 agent 都可以调用 `who_is_working`、`search_sessions`、`get_session_handoff` 等工具。

## 核心特性

- **27+ CLI 适配器** —— 读取原生 session 格式（Claude Code JSONL、Codex、Aider、Gemini、Goose、OpenHands、Cline、Crush、Pi、Qwen、Trae、Continue 等），无需修改 CLI
- **MCP server** —— 通过 stdio JSON-RPC 暴露 12 个工具；任何支持 MCP 的 agent 即可获得跨设备上下文
- **跨设备同步** —— 端到端加密；relay 只看到密文；自托管或使用共享 relay
- **Mount 系统** —— 非侵入式地把 MCP server、skill、always-on 上下文安装到每个 CLI 自己的配置目录
- **Session 接力** —— 提取浓缩 handoff 包（摘要 + 近期消息 + 任务计划），传给另一个 agent
- **每日简报** —— "你的 N 个 agent 跨 M 台设备今天做了 K 个任务，X% 成功率"
- **无 UI、无云锁定、无模型代理、无 agent 修改**

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

三个互不交叉的平面：

| 平面 | 数据流 |
|---|---|
| **本地** | CLI 原生文件 → 适配器 → SessionStore (SQLite) → MCP server (stdio) |
| **同步** | SessionStore → relay agent → 自托管 relay（仅密文）→ 对端设备 |
| **挂载** | ymesh skills / MCP 配置 → CLI 自己的配置目录（`~/.claude/`、`~/.codex/` 等） |

完整代码地图和架构不变式见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## CLI 覆盖

yondermesh 读取每个 CLI agent 的原生 session 格式。各 CLI 的挂载策略：

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

完整适配器矩阵（27+ CLI，覆盖等级 A/B/C）：[文档/reference/adapters](https://goyondertogether.github.io/yondermesh/zh/reference/adapters)

## 配置

`~/.yondermesh/config.yaml`：

```yaml
# 监控的设备和 agent
devices:
  - name: macbook
    agents:
      - type: claude-code
        path: ~/.claude/projects
      - type: codex
        path: ~/.codex/sessions

# 同步 relay（自托管或使用官方云）
sync:
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem  # 首次运行自动生成

# MCP server
mcp:
  enabled: true
  port: 0  # 默认 stdio 模式

# 每日简报
briefing:
  enabled: true
  output: ~/.yondermesh/briefings
```

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

- [x] **M1** —— daemon + collector + 本地 SQLite + MCP 查询工具 + 跨设备同步 + 简报
- [ ] **M2** —— `handoff_task`（agent 间任务委派，跨设备）
- [ ] **M3** —— 企业版：审计日志、RBAC、session 回放、合规报告

## 贡献

欢迎贡献。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目遵循 **docs-as-code** 纪律：每次代码改动必须在同一个 commit 中更新对应文档。doc-sync skill（`skills/doc-sync/`）自动化执行审计。

## 安全

见 [SECURITY.md](SECURITY.md)。威胁模型摘要：本地 SQLite（无静态加密）、同步 relay（仅密文）、MCP stdio（本地）、mount（写入 CLI 配置目录，永不修改二进制文件）。

## 许可证

MIT —— 由 [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether) 出品
