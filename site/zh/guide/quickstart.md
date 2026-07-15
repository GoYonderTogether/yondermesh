---
title: 快速上手
description: 安装 yondermesh，启动守护进程，完成第一次 session 扫描，并在五分钟内连接一个支持 MCP 的 Agent。
outline: [2, 3]
---

# 快速上手

本指南带你从零开始，在五分钟内跑起一个 yondermesh 守护进程，完成 session 采集，并连接
一个支持 MCP 的 Agent。

## 前置条件

- **Node.js 20 或更高版本**——yondermesh 要求 `>=20.0.0`。用 `node --version` 检查。
- **macOS、Linux 或 WSL**——守护进程监听文件系统事件并写入本地 SQLite 数据库。原生
  Windows 暂不支持，请使用 WSL。
- **至少已安装一个 CLI Agent**——Claude Code、Codex、Aider、Gemini CLI、Cursor、Windsurf、
  Continue、OpenCode，或任何[受支持的 adapter](/zh/reference/adapters) 中的一个。yondermesh
  读取的是 CLI 已经写下的 session；你不需要改变使用 CLI 的方式。

## 安装

从 npm 全局安装 `ymesh` CLI：

```bash
npm install -g yondermesh
```

验证安装：

```bash
ymesh version
```

如果你更倾向于从源码构建，或需要某个预发布版本，请参阅[安装](/zh/guide/installation)了解
所有选项。

## 启动守护进程

守护进程是唯一需要长期运行的进程。首次启动时，它会自动创建数据目录 `~/.yondermesh/`
（包括位于 `~/.yondermesh/yondermesh.db` 的 SQLite 数据库），并对本机能检测到的所有
adapter 执行一次初始扫描。

```bash
ymesh daemon
```

守护进程生命周期为：`启动 -> 扫描一次 -> 监听（fs 事件）-> 定时 reconcile -> 空闲`。
它只读原生 session 文件，从不修改。如果你希望数据目录不在 `~/.yondermesh/`，可以用
`YONDERMESH_HOME` 环境变量覆盖。

在一个终端里保持守护进程运行。再开一个终端执行下面的验证步骤。

::: tip
守护进程是唯一写入 SQLite 存储的进程。`ymesh` CLI 命令（`status`、`sessions`、
`active` 等）是对同一存储的只读薄查询，所以无论守护进程是否运行都能工作——但存储只有在
守护进程活跃时才会被刷新。
:::

## 验证扫描结果

检查守护进程状态和最近的扫描结果：

```bash
ymesh status
```

列出 yondermesh 在本机检测到的所有 Agent 及其覆盖状态：

```bash
ymesh agents
```

列出最近的 session（默认 20 条，可以提高 limit 看更多）：

```bash
ymesh sessions --limit 10
```

如果你只关心某一个 CLI，可以按来源或拓扑过滤：

```bash
ymesh sessions --source claude --topology root
```

查看当前正在运行的 session——也就是谁正在干活：

```bash
ymesh active
```

所有命令都支持 `--json` 以便脚本消费：

```bash
ymesh sessions --limit 10 --json
```

## 将 MCP 连接到你的 Agent

yondermesh 内置一个通过 stdio JSON-RPC 通信的 MCP 服务器。任何支持 MCP 的 Agent 都可以
调用它。将服务器添加到你 Agent 的配置文件中。

### Claude Code（claude_desktop_config.json）

编辑 `~/.claude/claude_desktop_config.json`（或你平台上的对应路径），在 `mcpServers` 下
添加 `yondermesh` 条目：

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

你也可以让 yondermesh 自动把自己注册到 Claude Code 和 Codex：

```bash
ymesh mcp register
```

随时检查注册状态：

```bash
ymesh mcp status
```

### Codex（config.toml）

对 Codex，将服务器添加到 `~/.codex/config.toml`：

```toml
[mcp_servers.yondermesh]
command = "ymesh"
args = ["mcp"]
```

### 其他支持 MCP 的 CLI

Cursor、Gemini 和 Windsurf 各自使用基于 JSON 的 MCP 配置文件
（`~/.cursor/mcp.json`、`~/.gemini/settings.json`、`~/.windsurf/mcp_config.json`）。
结构与上面的 Claude Code 示例相同。你也可以用 mount 系统一次性把 MCP 配置安装到所有检测
到的 CLI：

```bash
ymesh mount all
```

查看挂载状态：

```bash
ymesh mount status
```

::: warning
Trae 不支持文件挂载 MCP。如果要在 Trae 中使用 yondermesh MCP 工具，请在 Trae 设置 UI 中
手动添加 MCP 服务器（command: `ymesh`，args: `["mcp"]`）。各 CLI 的 mount 策略详见
[CLI 适配器参考](/zh/reference/adapters)。
:::

## 试用 MCP 工具

重启你的 Agent 让它加载新的 MCP 服务器，然后让它调用一个 yondermesh 工具。你也可以直接
在终端调用工具来验证连通性，无需走 Agent 往返：

```bash
ymesh mcp call who_is_working
```

最先值得试的几个工具：

- `recall_recent_work`——返回整个 mesh 中的近期 session。问你的 Agent："我的 Agent 们最近
  在做什么？"
- `whats_on_device`——检查某台设备的项目状态。问："我的笔记本上现在有什么？"
- `who_is_working`——列出当前活跃的 session。问："现在谁在干活？"
- `handoff_task`——为另一个 Agent 构建一个浓缩的交接包。

## 下一步

- [架构](/zh/guide/architecture)——了解三个平面（local / sync / mount）、代码地图、以及
  保持它们干净的不变量。
- [MCP Server](/zh/guide/mcp)——完整的工具列表、请求/响应结构，以及服务器如何注册到各
  CLI。
- [CLI 命令](/zh/reference/cli)——完整的命令参考，由 `ymesh help` 自动生成。
- [安装](/zh/guide/installation)——release 管理、macOS LaunchAgent 服务、以及如何卸载。
- [CLI 适配器](/zh/reference/adapters)——yondermesh 能采集 session 的所有 CLI Agent 的
  支持矩阵。
