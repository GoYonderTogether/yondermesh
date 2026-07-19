---
title: MCP Server
description: yondermesh 的 MCP server 通过 stdio JSON-RPC 把你的 session 图暴露给任何支持 MCP 的 agent —— 查询最近工作、查看活跃 session、交接任务、跨 session 通信。
outline: [2, 3]
---

# MCP Server

yondermesh 的 MCP server 是 AI 编码 agent 查询 session 图的主要读取入口。它使用 stdio JSON-RPC（MCP 协议版本 `2024-11-05`）通信，对外暴露一组工具，任何支持 MCP 的 CLI —— Claude Code、Codex、Cursor、Gemini、Windsurf 等 —— 都能在自己的 session 里直接调用。

Server 实现在 `src/mcp/server.ts`（`McpServer` 类）。它读取与 daemon 写入相同的 `SessionStore`，并额外在需要时直接读取磁盘上的原生 session 文件以获取正在运行的 session 的实时内容。对 agent 而言 server 是无状态的：每次 `tools/call` 请求都是一次独立查询，server 不会在调用之间保留任何 per-agent 状态。

## MCP server 是什么

Server 是一个薄薄的 JSON-RPC 路由层，背后是三个数据源：

- 本地 SQLite `SessionStore`（`~/.yondermesh/yondermesh.db`）：用于结构化 session 查询、统计、活跃 session 摘要以及跨 session 消息总线。
- 磁盘上的原生 CLI session 文件（`~/.claude/projects/`、`~/.codex/sessions/` 等）：用于 live 模式读取正在运行的 session，数据库可能比文件滞后几秒。
- extract 的 NDJSONL 索引（`~/.yondermesh/extracts/<project-hash>/`）：用于按项目历史查询用户需求和 agent 响应。

它实现了三个 JSON-RPC 方法：`initialize`（返回 server 信息与能力）、`tools/list`（返回工具定义）、`tools/call`（分发到对应工具处理器）。未知方法返回 `-32601 Method not found`，JSON 解析失败返回 `-32700 Parse error`。

## 启动 server

Server 默认以 **stdio 模式**运行 —— 没有 HTTP 传输。启动命令：

```bash
ymesh mcp
```

它会连接本地 SQLite 数据库 `~/.yondermesh/yondermesh.db`，在 stdin/stdout 上监听换行分隔的 JSON-RPC 消息。通常你不会手动运行它 —— agent 会通过自己的 MCP 配置把它作为子进程拉起。可以用 `--db <path>` 覆盖数据库路径。

## 注册到 agent

`ymesh mcp register` 会把 yondermesh MCP server 注册到 ymesh 能通过文件配置的两个 agent：

```bash
ymesh mcp register
```

它会写入：

- **Claude Code** —— `~/.claude.json` 的 `mcpServers.yondermesh`，类型为 `stdio`。
- **Codex** —— `~/.codex/config.toml`，追加一个 `[mcp_servers.yondermesh]` 段，包含 `command` 和 `args`。

注册逻辑在 `src/mcp/register.ts`，会自动解析正确的 node 可执行文件（`process.execPath`）和已安装的 ymesh 入口（`~/.yondermesh/bin/ymesh`，开发环境回退到 `dist/bin/ymesh.js`），你无需手动硬编码路径。注册后，这些 CLI 的新 session 会自动加载 server；已经在运行的 session 需要重启或重连才能生效。

其它支持 MCP 的 CLI（Cursor、Gemini、Windsurf 等）请使用挂载系统（`ymesh mount all`）或手动添加 JSON/TOML 片段 —— 见下文 [Agent 配置片段](#agent-配置片段)。Trae 通过 IDE 设置界面配置 MCP，不走文件。

## 注册状态

查询 ymesh 当前是否已注册：

```bash
ymesh mcp status
```

会针对 Claude Code 和 Codex 报告 `registered: true/false`，并给出检查的配置文件路径。Claude 的注册状态通过检查 `~/.claude.json` 中是否存在 `mcpServers.yondermesh` 判定；Codex 的注册状态通过扫描 `~/.codex/config.toml` 中是否存在 `[mcp_servers.yondermesh]` 头判定。

## 注销

从 Claude Code 和 Codex 配置中移除 ymesh：

```bash
ymesh mcp unregister
```

它会从 `~/.claude.json` 删除 `yondermesh` 条目，并从 `~/.codex/config.toml` 移除 `[mcp_servers.yondermesh]` 段（包括 `[mcp_servers.yondermesh.env]` 子表）。操作幂等 —— 重复执行是安全的，未注册时注销只会对该 CLI 返回 `false`，不会报错。

## 直接调用工具

不启动 agent，直接在终端调用任意 MCP 工具：

```bash
ymesh mcp call <tool> [args]
```

示例：

```bash
# 快速查看本机谁在干活
ymesh mcp call list_active

# 搜索最近 7 天的 codex session
ymesh mcp call search_sessions source=codex since=7d

# 获取某个 session id 的浓缩 handoff 包
ymesh mcp call handoff session_id=019f5fe4-b127-7de2-b8f1-efa45bee24cb

# 以 live 模式查看正在运行的 session，保留 tool call
ymesh mcp call get_session session_id=<id> live=true include_tool_calls=true

# 向某个项目下所有 agent 广播消息
ymesh mcp call mailbox action=post to_project=/Users/YOU/projects/app body="tests are red on main"
```

参数会作为工具的 `arguments` 对象传入。输出是工具结果的原始内容（JSON 或纯文本，取决于工具）。这在脚本编排、调试和快速查看时很有用。

## MCP 工具

工具面是 **8 个正交核心工具** 加 4 个辅助工具，定义在 `src/mcp/server.ts`（`McpServer.listTools()`，核心集在 `ORTHOGONAL_TOOL_NAMES` 常量里）。逐参数、逐返回值的规范参考由 `listTools()` 自动生成 —— 这里不再重复，见 **[MCP 工具参考](/zh/reference/mcp-tools)**。

核心工具一览：

| 工具 | 用途 |
| --- | --- |
| `search_sessions` | 跨所有 agent 搜索 session（时间 / 项目 / agent / 拓扑过滤 + 全文 `query`）。 |
| `get_session` | 单个 session 的完整消息流；`live` 读正在运行的 session，`handoff_mode` 用于接管，`include_relations` 带拓扑关系。 |
| `list_active` | 当前活跃或等待 review 的 session，附运行时摘要。 |
| `overview` | 本地 session 库的聚合统计。 |
| `handoff` | 用于任务接管的浓缩 `HandoffPackage` —— 见 [Handoff 包](#handoff-包)。 |
| `send` | 同步向目标 CLI 注入一条消息并拿回回复 —— 见 [同步注入](#同步注入-send)。 |
| `mailbox` | 异步的跨 session 消息总线（post / check / reply / get）。 |
| `agents` | 列出本机 agent CLI，含安装状态、覆盖情况和挂载能力。 |

4 个辅助工具（`extract_project_history`、`query_user_requirements`、`query_agent_responses`、`yondermesh_whoami`）负责项目历史提取与自我识别。旧工具名（`get_session_detail`、`get_session_handoff`、`list_active_sessions`、`who_is_working`、`get_overview`、`post_message`、`yondermesh_*` 等）仍保留为 **deprecated 转发别名**，让现有调用方继续可用。

### 相对时间

多个工具接受 `since` / `from` / `to` 参数。ymesh 同时支持 ISO 8601 时间戳和紧凑相对格式：

- `7d` —— 7 天前
- `24h` —— 24 小时前
- `30m` —— 30 分钟前

其它字符串会尝试按 ISO 8601 解析。无法解析的输入视为"不过滤"。

## Agent 配置片段

每个支持 MCP 的 CLI 把 MCP server 配置存放在不同位置、用不同格式。下面的片段都以相同方式拉起 ymesh —— `node`（或 `ymesh` 启动器）带 `mcp` 子命令。如果你全局安装，把 `/Users/YOU/.yondermesh/bin/ymesh` 换成 `which ymesh` 输出的路径。

### Claude Code

`~/.claude.json`：

```json
{
  "mcpServers": {
    "yondermesh": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"],
      "env": {}
    }
  }
}
```

建议用 `ymesh mcp register`（或 `ymesh mount all`）而不是手动编辑此文件 —— 注册代码会自动解析正确的 node 二进制和 ymesh 入口路径。

### Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.yondermesh]
command = "/usr/local/bin/node"
args = ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
```

### Cursor

`~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
    }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`（旧版安装可能是 `~/.windsurf/mcp_config.json`）：

```json
{
  "mcpServers": {
    "yondermesh": {
      "command": "node",
      "args": ["/Users/YOU/.yondermesh/bin/ymesh", "mcp"]
    }
  }
}
```

### Trae

Trae **不**把 MCP 配置作为文件暴露给 ymesh 写入。请通过 Trae IDE 设置界面配置：新增一个 MCP server，command 填 `ymesh`，args 填 `["mcp"]`。国际版（`~/.trae`）和中文版（`~/.trae-cn`）需要在各自的 IDE 实例里分别配置；同一变体内 Trae IDE 与 Trae Work 共用用户级配置目录，所以一条配置就覆盖两者。

## Handoff 包

`handoff`（以及 `get_session` 的 `handoff_mode=true`）会从 codex rollout JSONL 构建 `HandoffPackage`，Claude Code session 回退到简化版。包由 `src/mcp/codex-handoff.ts` 构建，包含：

- `session_meta` —— cwd、topology（`root` / `subagent`）、model、CLI 版本、originator。
- `compacted_summaries` —— codex post-compact 摘要，按 `window_number` 升序排列。冗余的 `replacement_history` 已剔除。
- `last_user_message` —— 最后一条真实 user 消息；系统前置内容（如 `<user_instructions>`、`<environment_context>`、`<system_message>`、`<system-reminder>`）会被跳过，确保拿到用户的真实意图。
- `recent_messages` —— session 尾部消息，保留 `function_call`、`function_call_output`、`custom_tool_call`（arguments 和 output 截断到 2000 字符以防过大）。
- `task_plan` —— 从尾部 `update_plan` 或任何带 plan 的 tool call 提取；渲染为 `explanation` 加 `- ` 开头的 plan 步骤列表。
- `is_live` / `last_activity_sec_ago` —— 文件 `mtime` 与 2 分钟 liveness 阈值的比较结果。

这与 CLI 的 `ymesh handoff <id>` 产出同一个包，MCP 与 CLI 的 handoff 可以互换。

## 跨 session 消息总线

`mailbox` 工具是一个轻量的**异步**跨 session 消息总线，后端是本地 SQLite。通过 `action` 选择操作：`post`（发直接消息或项目广播）、`check`（读未读）、`reply`、`get`。消息可以发给指定 session（`to_session_id`，直接消息）或某个项目（`to_project`，广播给该项目下所有 agent）。消息读取后会自动标记已读，所以 agent 用 `mailbox action=check` 轮询时只会看到新消息。

该总线仅本机有效 —— 不会被跨设备同步复制（同步[规划中](/zh/guide/sync)，尚未实现）。它适合同机 agent 之间的协调（例如一个 agent 通知另一个 agent 测试挂了）。

`mailbox` 是异步的（留言，稍后轮询取回）。当你需要**同步**往返 —— 问一句、阻塞等回复 —— 用 `send`（见下）。旧的 `yondermesh_mailbox_*` / `post_message` / `get_messages` 名称仍作为 deprecated 别名保留，路由到同一条总线。

## 同步注入 send

`send` 是同步注入入口 —— 它把一条 user message 发给任意已接入的 CLI agent，并在同一次调用里拿回回复。这正是补上异步 mailbox 留下的缺口：用 `mailbox` 一个 agent 可以给另一个 agent 留言，但没法"问一句、答一句"；`send` 可以。（旧调用方可能把这个工具叫 `yondermesh_send`，现已是 deprecated 别名。）

| 参数 | 必填 | 说明 |
|---|---|---|
| `cli` | 是 | 目标 CLI id（`hermes`、`opencode`、`kimi`、`pi`、`aider`、`amp`、`antigravity`、`cline`、`codebuddy`、`continue`、`copilot`、`crush`、`cursor-ide`、`factory`、`gemini`、`goose`、`openclaw`、`openhands`、`qwen`、`trae-cli`、`trae-ide`、`vibe`、`windsurf`……）。 |
| `message` | 是 | 要注入的 user message。 |
| `mode` | 否 | `stopped` / `running` / `new`（默认 `new`）。 |
| `session_id` | 否 | `stopped` 与 `running` 模式必填；`new` 模式忽略。 |
| `model` | 否 | `new` 模式下指定模型。 |
| `effort` | 否 | `new` 模式下指定投入度：`low` / `medium` / `high`。 |
| `cwd` | 否 | 目标 session 的工作目录。 |
| `timeout_ms` | 否 | 投递超时，默认 60000。 |
| `from_session_id` | 否 | 发送方 session id（用于审计）。 |

返回 `{ cli, mode, delivered, response, exitCode, channel, latencyMs, newSessionId, error, messageId, replyMessageId }`。`delivered` 为 true 表示消息已送达 CLI（即使回复为空）。`response` 是清洗后的回复文本 —— `ReplyAdapter` 会剥离 ANSI、丢弃 CLI banner 与日志行、折叠空行，所以你拿到的是 agent 的真实回答，而不是它的启动噪声。完整线程（你的消息 + 回复）会被审计写入 `agent_messages`（你的消息记为 `kind=question`，回复记为 `kind=task_update`，通过 `replyToId` + `threadId=thread-<messageId>` 关联）。

失败永不沉默。`send` 永不抛异常（参数校验除外），永不挂起。未知 CLI、未配 model、非零退出、上游 API 限流 —— 全部以文本形式回到 `response` 或 `error`，并置 `delivered=false`。CLI 自己的报错文本会原样出现在 `response` 里，调用方能看到到底哪里出了问题。

同一能力在 CLI 侧是 `ymesh send` —— 示例见 [快速开始](/zh/guide/quickstart#向任意-agent-提问拿回回复)。内部架构在 `src/mailbox/core.ts`（`MailboxCore.send`）、`src/trigger/adapter.ts`（`TriggerAdapter`）、`src/trigger/reply-adapter.ts`（`ReplyAdapter`）—— 四平面模型见 [架构](/zh/guide/architecture)。

## 相关

- [MCP 工具参考](/zh/reference/mcp-tools) —— 规范的自动生成工具列表。
- [Mount 系统](/zh/guide/mount) —— 一次性把 ymesh 挂载到所有支持的 CLI。
- [Session 与拓扑](/zh/guide/sessions) —— MCP 工具查询的数据模型。
- [CLI 命令](/zh/reference/cli) —— `ymesh mcp` 子命令参考。
