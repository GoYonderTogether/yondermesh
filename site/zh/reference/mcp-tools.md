---
title: MCP 工具
description: yondermesh MCP server (ymesh mcp) 暴露的全部工具权威参考 — 参数、返回结构、CLI 调用示例。
outline: [2, 3]
---

# MCP 工具

`ymesh mcp` 命令启动一个 stdio JSON-RPC server，把 yondermesh 的 session 图暴露给任何支持 MCP 的 agent（Claude Code、Codex、Cursor、Gemini、Windsurf、Continue 等）。注册后，agent 可调用这些工具查询近期工作、查看本机正在发生什么、交接任务，以及跨 session 收发消息。

本页为权威工具列表，依据 `src/mcp/server.ts` 整理。工具按注册顺序列出。

## 如何调用

### 从 CLI 调用

```bash
ymesh mcp call <tool> [args]
```

参数以 `key=value` 形式传入。示例：

```bash
ymesh mcp call who_is_working
ymesh mcp call search_sessions agent=claude since=7d limit=10
ymesh mcp call get_session_detail session_id=019f5fe4-b127-7de2-b8f1-efa45bee24cb live=true
```

### 从支持 MCP 的 agent 调用

在 agent 的 MCP 配置中注册 server：

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

agent 随后发出带 `name` 和 `arguments` 的 JSON-RPC `tools/call` 请求。yondermesh 返回 `{ content: [{ type: "text", text: <json-or-text> }], isError: false }`。

### 通用约定

- **Session ID** 是各 CLI 的原生 ID（如 Claude Code 的 UUIDv7、Codex 的 rollout 文件名 stem）。
- **相对时间**字符串（`since`、`from`、`to`）接受 ISO 8601 时间戳或 `<n><unit>` 简写，unit 为 `d` / `h` / `m`（如 `7d`、`24h`、`30m`）。
- **拓扑（topology）** 为 `root`（用户发起的真实会话）或 `subagent`（被其他 agent 调起的子会话）。未显式请求 subagent 的查询默认只返回 root。
- 工具返回的 JSON 均为单行 `JSON.stringify` 输出；下方示例为可读性做了 pretty-print。

## search_sessions

搜索本机所有 agent 的 session 记录。在开始新任务前用此工具查找相关历史工作。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_path` | string | 否 | 项目路径精确匹配 |
| `project_prefix` | string | 否 | 项目路径前缀匹配（目录边界安全） |
| `agent` | string | 否 | 按规范 source 过滤：`claude`、`codex`、`opencode`、`hermes`、`kimi`、`cursor`、`copilot`、`gemini` |
| `topology` | string | 否 | `root` 或 `subagent` |
| `since` | string | 否 | ISO 8601 或相对时间（`7d` / `24h` / `30m`） |
| `limit` | number | 否 | 返回条数，默认 20，限制在 1-200 |

### 返回

JSON 数组，每项为 session 摘要对象：

```json
[
  {
    "id": "019f5fe4-b127-7de2-b8f1-efa45bee24cb",
    "source": "claude",
    "projectPath": "/Users/zoran/projects/yondermesh",
    "cwd": "/Users/zoran/projects/yondermesh",
    "topology": "root",
    "messageCount": 42,
    "startedAt": 1719500000000,
    "lastSeenAt": 1719503600000,
    "model": "claude-sonnet-4",
    "cliVersion": "1.0.0",
    "originator": "cli",
    "threadSource": "claude-code"
  }
]
```

### 示例

```bash
ymesh mcp call search_sessions project_prefix=/Users/zoran/projects since=7d limit=5
```

## get_session_detail

返回某个 session 的消息流。支持 `live` 模式直接重读源文件（正在运行的 session 也能读到最新消息），以及面向任务接管的 handoff 选项。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | 是 | Session ID |
| `live` | boolean | 否 | `true` = 直接读源文件（推荐用于运行中的 session） |
| `limit` | number | 否 | 只返回最后 N 条消息 |
| `include_compacted` | boolean | 否 | live 模式下附带 `compacted_summaries`（codex 压缩摘要）。默认 `false` |
| `include_tool_calls` | boolean | 否 | live 模式下保留 `function_call` / `function_call_output` 块（带截断）。默认 `false` |
| `handoff_mode` | boolean | 否 | `true` = 等价于 `live=true + include_compacted=true + include_tool_calls=true + limit=30`。默认 `false` |

### 返回

默认（DB 或纯 live 模式）：JSON 消息数组：

```json
[
  { "seq": 0, "role": "user", "content": "..." },
  { "seq": 1, "role": "assistant", "content": "...", "timestamp": 1719500001000 }
]
```

富上下文模式（`include_compacted` / `handoff_mode`）：JSON 对象：

```json
{
  "messages": [ /* 近期消息，保留 tool call */ ],
  "compacted_summaries": [ /* codex 压缩历史 */ ]
}
```

### 示例

```bash
ymesh mcp call get_session_detail session_id=019f5fe4-... live=true handoff_mode=true
```

## get_session_handoff

专为任务接管设计。直接读源文件，返回浓缩 handoff 包：codex 压缩摘要、最后一条真实 user 消息、尾部近况（保留 `function_call` / `function_call_output` / `custom_tool_call`，带截断）、task plan、session 元数据与活跃状态。当一个 agent 需要接力另一个 agent 而不丢失 tool 调用细节时使用。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | 是 | Session ID |
| `tail_messages` | number | 否 | 尾部含 tool call 的消息条数。默认 `30` |

### 返回

JSON `HandoffPackage` 对象（完整结构见 `src/mcp/codex-handoff.ts`）：

```json
{
  "session_id": "...",
  "compacted_summaries": [ "..." ],
  "last_user_message": "...",
  "recent_messages": [ /* 尾部，保留 tool call */ ],
  "task_plan": [ /* update_plan 项，若存在 */ ],
  "session": { /* session 元数据 */ },
  "is_live": true
}
```

### 示例

```bash
ymesh mcp call get_session_handoff session_id=019f5fe4-... tail_messages=50
```

## get_session_relations

查询某个 session 的关系拓扑：父会话、子会话与关联会话。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | 是 | Session ID |

### 返回

JSON 关系数组：

```json
[
  { "type": "spawned", "direction": "outgoing", "sessionId": "child-uuid" },
  { "type": "forked", "direction": "incoming", "sessionId": "parent-uuid" }
]
```

`direction` 为 `outgoing`（本 session 派生了关联 session）或 `incoming`（关联 session 派生了本 session）。

### 示例

```bash
ymesh mcp call get_session_relations session_id=019f5fe4-...
```

## get_overview

返回本机全部 session 的统计概览。适用于每日摘要或快速健康检查。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `since` | string | 否 | 只统计此时间之后开始的 session（ISO 8601 或相对时间） |
| `project_prefix` | string | 否 | 只统计项目路径匹配此前缀的 session |

### 返回

JSON `SessionStats` 对象（结构由 `src/store/types.ts` 定义）：通常包含总数、按 source 分布、按 topology 分布以及按时间桶的活动量。

### 示例

```bash
ymesh mcp call get_overview since=24h
```

## list_active_sessions

列出当前正在运行或最近活跃的 session，附带运行时摘要。直查数据库，反映最近扫描周期的状态。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `within_minutes` | number | 否 | 回看窗口（分钟）。默认 `30` |

### 返回

JSON `ActiveSessionsSummary` 对象：

```json
{
  "totalActive": 3,
  "liveCount": 2,
  "subagentActive": 1,
  "bySource": { "claude": 2, "codex": 1 },
  "sessions": [
    {
      "sessionId": "019f5fe4-...",
      "source": "claude",
      "cwd": "/Users/zoran/projects/yondermesh",
      "topology": "root",
      "isLive": true,
      "lastSeenAt": 1719503600000
    }
  ]
}
```

### 示例

```bash
ymesh mcp call list_active_sessions within_minutes=10
```

## who_is_working

快速、人类可读地查询本机当前有哪些 agent 正在工作。返回纯文本而非 JSON — 设计目标是让 agent 在开始任务前快速感知机器上的活动状态。

### 参数

无。

### 返回

纯文本。示例：

```text
本机当前有 3 个 session 活跃中（2 个 live，1 个 subagent）：

[live] 019f5fe4-b...  claude        ~/projects/yondermesh  最近 12 秒前
[live] 019f6a21-c...  codex         ~/projects/myapp      最近 3 分钟前
[    ] sub:019f6b40-  claude        ~/projects/yondermesh  最近 8 分钟前

按 source 分布: claude=2, codex=1
```

### 示例

```bash
ymesh mcp call who_is_working
```

## post_message

向另一个 agent session 发送消息或向项目广播。用于跨 session 通信 — 例如通知另一个 agent 任务完成、提出问题或建议交接。消息存于本地 SQLite，接收方通过 `get_messages` 读取。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `body` | string | 是 | 消息内容 |
| `to_session_id` | string | 否 | 直接消息 — 目标 session ID |
| `to_project` | string | 否 | 广播 — 目标项目路径（该项目下所有 agent 都会收到） |
| `from_session_id` | string | 否 | 发送方 session ID |
| `kind` | string | 否 | 取值 `info`、`warning`、`question`、`task_update`。默认 `info` |

`to_session_id` 与 `to_project` 至少设一个；都未设时消息以无接收者方式存储。

### 返回

```json
{ "messageId": 42, "posted": true }
```

### 示例

```bash
ymesh mcp call post_message to_session_id=019f6a21-c... body="Tests pass, ready to merge" kind=task_update
```

## get_messages

读取发给当前 session 或项目的消息。读取后自动标记为已读。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `for_session_id` | string | 否 | 查发给此 session 的直接消息 |
| `for_project` | string | 否 | 查发给此项目的广播 |
| `since_minutes` | number | 否 | 回看窗口（分钟）。默认 `60` |
| `unread_only` | boolean | 否 | 只返回未读消息。默认 `false` |

### 返回

JSON 消息数组（结构来自 `src/store/`）：

```json
[
  {
    "id": 42,
    "toSessionId": "019f6a21-...",
    "fromSessionId": "019f5fe4-...",
    "body": "Tests pass, ready to merge",
    "kind": "task_update",
    "createdAt": 1719503600000,
    "read": false
  }
]
```

### 示例

```bash
ymesh mcp call get_messages for_session_id=019f6a21-... unread_only=true
```

## extract_project_history

提取某个项目所有 session 历史中的用户需求（user 消息）和 agent 响应（assistant 消息），存为可索引的 NDJSONL 文件。这是了解用户在某个项目上真实需求的第一步。若 `force_refresh=false` 且已有提取结果，直接返回现有统计不重新提取。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_path` | string | 是 | 项目路径（cwd 前缀匹配） |
| `force_refresh` | boolean | 否 | `true` = 强制重新提取。默认 `false` |

### 返回

```json
{
  "projectHash": "a1b2c3...",
  "projectPath": "/Users/zoran/projects/yondermesh",
  "requirementCount": 128,
  "responseCount": 412,
  "sessionCount": 14,
  "extractedAt": 1719503600000,
  "extractsDir": "~/.yondermesh/extracts/a1b2c3...",
  "refreshed": true
}
```

### 示例

```bash
ymesh mcp call extract_project_history project_path=/Users/zoran/projects/yondermesh force_refresh=true
```

## query_user_requirements

查询某项目的用户需求（user 消息）。可按关键词、session、时间范围、精确行 ID 过滤。需先调用 `extract_project_history` 完成提取。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_path` | string | 是 | 项目路径（需与 `extract_project_history` 时一致） |
| `keyword` | string | 否 | 大小写不敏感的 content 子串匹配 |
| `session_id` | string | 否 | 按 session ID 过滤 |
| `from` | string | 否 | 起始时间（ISO 8601 或相对时间） |
| `to` | string | 否 | 结束时间（ISO 8601 或相对时间） |
| `id` | number | 否 | 精确行 ID（1-based）。命中时忽略其它过滤 |
| `limit` | number | 否 | 返回上限。默认 `20`，限制在 1-500 |
| `offset` | number | 否 | 跳过前 N 条。默认 `0` |

### 返回

JSON 需求条目数组（每项含 `id`、`sessionId`、`content`、`timestamp`）。

### 示例

```bash
ymesh mcp call query_user_requirements project_path=/Users/zoran/projects/yondermesh keyword=auth limit=10
```

## query_agent_responses

查询某项目的 agent 响应（assistant 消息）。过滤语义与 `query_user_requirements` 相同。需先调用 `extract_project_history` 完成提取。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_path` | string | 是 | 项目路径（需与 `extract_project_history` 时一致） |
| `keyword` | string | 否 | 大小写不敏感的 content 子串匹配 |
| `session_id` | string | 否 | 按 session ID 过滤 |
| `from` | string | 否 | 起始时间（ISO 8601 或相对时间） |
| `to` | string | 否 | 结束时间（ISO 8601 或相对时间） |
| `id` | number | 否 | 精确行 ID（1-based）。命中时忽略其它过滤 |
| `limit` | number | 否 | 返回上限。默认 `20`，限制在 1-500 |
| `offset` | number | 否 | 跳过前 N 条。默认 `0` |

### 返回

JSON 响应条目数组（每项含 `id`、`sessionId`、`content`、`timestamp`）。

### 示例

```bash
ymesh mcp call query_agent_responses project_path=/Users/zoran/projects/yondermesh session_id=019f5fe4-... limit=20
```

## yondermesh_mailbox_post

> **（legacy v2，同步投递请优先用 `yondermesh_send`）** — v2 是异步模型（写入 SQLite，目标方轮询读取）。要同步发送并拿回复，请改用 [`yondermesh_send`](#yondermesh_send)。

向另一个 session 投递消息或向项目广播。后端为 `MailboxCore`（`src/mailbox/core.ts`），存入共享 SQLite。支持优先级、过期、线程。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `body` | string | 是 | 消息内容 |
| `to_session_id` | string | 否 | 直投——目标 session ID |
| `to_project` | string | 否 | 广播——目标项目路径 |
| `from_session_id` | string | 否 | 发送方 session ID |
| `kind` | string | 否 | `info` / `warning` / `question` / `task_update`。默认 `info` |
| `priority` | string | 否 | `normal` / `urgent`。默认 `normal` |
| `expires_in_seconds` | number | 否 | TTL；超过该秒数后消息自动清理 |
| `thread_id` | string | 否 | 显式线程 ID；使用 `yondermesh_mailbox_reply` 时自动派生 |

`to_session_id` 与 `to_project` 至少传一个。

### 返回

```json
{ "messageId": 42, "posted": true }
```

### 示例

```bash
ymesh mcp call yondermesh_mailbox_post to_session_id=019f6a21-c... body="紧急：构建挂了" priority=urgent expires_in_seconds=3600
```

## yondermesh_mailbox_check

> **（legacy v2，同步投递请优先用 `yondermesh_send`）** — 用此工具读取历史/排队消息；要同步投递请用 [`yondermesh_send`](#yondermesh_send)。

Peek 或 pop 当前 session 的未读消息，并消费 daemon 推送的 tray 通知。这是主"收件箱"调用。`mark_read=true`（默认）时消息被原子地弹出并标记已读；`mark_read=false` 时仅 peek，无副作用。

self session 解析三层降级（按序）：`YONDERMESH_SELF_SESSION_ID` 环境变量 → `self_session_id` 参数 → cwd 匹配活跃 session。首个命中的层胜出。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `self_session_id` | string | 否 | 显式 self session ID（覆盖 cwd 查找，但环境变量优先级更高） |
| `mark_read` | boolean | 否 | `true`（默认）= pop 语义（读 + 标记已读）；`false` = peek（无副作用） |

### 返回

```json
{
  "sessionId": "019f6a21-...",
  "markRead": true,
  "unread": { "direct": 1, "broadcast": 0, "total": 1 },
  "trayNotices": [],
  "messages": [
    {
      "id": 42,
      "toSessionId": "019f6a21-...",
      "fromSessionId": "019f5fe4-...",
      "body": "测试通过，可合并",
      "kind": "task_update",
      "priority": "normal",
      "threadId": null,
      "createdAt": 1719503600000
    }
  ],
  "hint": "📬 你有 1 条未读消息（direct 1, broadcast 0）。处理后可调 yondermesh_mailbox_post 回复。"
}
```

无法解析 self 时返回 `isError: true`。

### 示例

```bash
ymesh mcp call yondermesh_mailbox_check self_session_id=019f6a21-c... mark_read=false
```

## yondermesh_mailbox_reply

> **（legacy v2，同步投递请优先用 `yondermesh_send`）** — v2 是异步模型（写入 SQLite）。要同步投递请改用 [`yondermesh_send`](#yondermesh_send)。

回复某条消息。自动派生 `thread_id`：若父消息已有线程则继承，否则新建 `thread-<parent_id>`。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `reply_to_id` | number | 是 | 被回复消息的 ID |
| `body` | string | 是 | 回复内容 |
| `from_session_id` | string | 否 | 发送方 session ID |

### 返回

```json
{ "messageId": 43, "posted": true, "threadId": "thread-42" }
```

`reply_to_id` 不存在时返回 `isError: true`。

### 示例

```bash
ymesh mcp call yondermesh_mailbox_reply reply_to_id=42 body="收到，处理中" from_session_id=019f5fe4-...
```

## yondermesh_whoami

解析并报告当前 session 的身份，附带未读消息提示。适合 agent 在任务开始时确认"我是谁"，并感知待处理邮箱消息。使用与 `yondermesh_mailbox_check` 相同的三层 self 解析。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `self_session_id` | string | 否 | 显式 self session ID（覆盖 cwd 查找；环境变量仍优先） |

### 返回

```json
{
  "sessionId": "019f6a21-...",
  "resolved": true,
  "unread": { "direct": 1, "broadcast": 0, "total": 1 },
  "hint": "📬 你有 1 条未读消息（direct 1, broadcast 0）。处理后可调 yondermesh_mailbox_post 回复。"
}
```

无法解析 self 时：

```json
{
  "sessionId": null,
  "resolved": false,
  "hint": "无法解析 self session id。可通过 self_session_id 显式传入..."
}
```

### 示例

```bash
ymesh mcp call yondermesh_whoami
```

## yondermesh_send

同步地把一条 user message 投递到目标 agent CLI session，并在同一次调用里拿到 agent 的回复。这是 v3 同步注入工具 —— 与 legacy 的 `yondermesh_mailbox_*`（v2 异步：写 SQLite，目标方轮询）不同，`yondermesh_send` 立即通过 `TriggerAdapter` 投递消息，并通过 `ReplyAdapter` 捕获清洗后的回复。

后端为 `MailboxCore.send()`（`src/mailbox/core.ts`）。`send()` 内部流程：

1. **审计写入 user 消息** 到 `agent_messages`（kind=`question`）。
2. **TriggerAdapter.trigger()** 通过对应通道（cli-spawn / stdin / http-api / ws-rpc / tmux / applescript）把消息投递到目标 CLI。
3. **ReplyAdapter.extractReply()** 清洗原始 `TriggerResult.response` —— 去 ANSI 转义、按 CLI 过滤专属噪声（如 hermes 的 `Warning: Unknown toolsets:` 行、claude 的 `Tip:` 行）、剔除日志/横幅前缀、折叠多余空行。
4. **审计写入回复** 到 `agent_messages`（kind=`task_update`，通过 `replyToId` + `threadId` 关联）。
5. 返回 `SendResult`（见下）。

即使目标 agent 未配置 model、认证失败、或上游 API 限流，`send()` 也会在 `response` / `error` 中返回错误信息，而不会 hang 住。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cli` | string | 是 | 目标 CLI id（如 `hermes`、`claude`、`opencode`、`trae-ide`） |
| `message` | string | 是 | 要注入目标 agent session 的 user message |
| `mode` | string | 否 | 投递模式：`stopped`（用消息恢复一个已停止的 session）、`running`（注入运行中的 session）、`new`（创建新 session）。默认 `new` |
| `session_id` | string | 否 | 目标 session id。`stopped` / `running` 必填；`new` 忽略 |
| `model` | string | 否 | `new` 模式指定的 model（如 `gpt-4o`、`claude-sonnet-4`） |
| `effort` | string | 否 | `new` 模式指定的 effort（如 `low` / `medium` / `high`） |
| `cwd` | string | 否 | 目标 session 工作目录 |
| `timeout_ms` | number | 否 | 超时毫秒。默认 `60000` |
| `from_session_id` | string | 否 | 发送方 session id（用于审计） |

### 返回

JSON 对象（`SendResult`）：

```json
{
  "cli": "hermes",
  "mode": "new",
  "delivered": true,
  "response": "PONG",
  "exitCode": 0,
  "channel": "cli-spawn",
  "latencyMs": 3214,
  "newSessionId": "019f6a21-c...",
  "messageId": 21,
  "replyMessageId": 22
}
```

字段说明：

- `delivered` — 消息是否成功投递到目标 CLI（即使 agent 没有回复也 true）。
- `response` — 经 `ReplyAdapter` 清洗后的 agent 回复文本（可能为空字符串）。
- `exitCode` — `cli-spawn` 通道的进程退出码。
- `channel` — 实际使用的触发通道（`cli-spawn` / `stdin` / `http-api` / `ws-rpc` / `tmux` / `applescript`）。
- `latencyMs` — `send()` 总耗时（含审计 + 触发 + 回复提取）。
- `newSessionId` — `mode=new` 且创建了 session 时存在。
- `error` — 失败原因；`delivered=false` 时一定有值。
- `messageId` — user 消息的审计行 id（始终存在，即使投递失败）。
- `replyMessageId` — assistant 回复的审计行 id（仅当捕获到非空回复时存在）。

### 失败语义

- 无效 `mode`，或 `stopped`/`running` 缺 `session_id` → `isError: true` 并附校验信息。
- 未知 CLI（不在 `WRAPPER_LOADERS` 中） → `delivered: false`、`error` 有值，`messageId` 仍会分配（审计行已写）。
- `TriggerAdapter.trigger()` 抛错 → 被捕获，返回 `delivered: false` 并把异常文本放入 `error`。
- 目标 CLI 非零退出（如上游 API 429） → `delivered: true`、`exitCode` 非零，CLI 自己的错误文本会出现在 `response` 中，调用方据此可见发生了什么。

### 示例

```bash
ymesh mcp call yondermesh_send cli=hermes mode=new message="只回复 PONG 一个词，不要任何其它内容。"
```

```bash
ymesh send --cli hermes --message "hello" --mode new --json
```

等价的 shell 命令见 [`ymesh send`](./cli#send)。

## Channel A：未读消息 piggyback 提示

当当前 session 有未读邮箱消息时，**任何**非 mailbox MCP 工具的响应文本末尾都会被追加一行 `📬 mailbox: N unread`。这让 agent 无需主动轮询即可感知待处理消息——提示作为普通工具调用的副作用浮现。

提示由 `src/mcp/server.ts` 的 `McpServer.callTool()` 注入，在主工具执行后调用 `MailboxCore.countUnread()`，反映调用后状态。要消除提示，调 `yondermesh_mailbox_check` 并设 `mark_read=true` 清空未读计数。

## 相关页面

- `/guide/mcp` — 如何在各 agent 配置中注册 MCP server
- `/reference/cli` — `ymesh mcp call`、`ymesh mcp register`、`ymesh mcp status`
- `/reference/config` — `config.yaml` 的 `mcp` 段
