---
title: MCP 工具
description: yondermesh MCP server（ymesh mcp）暴露的正交工具集参考 —— 参数与调用方式。
outline: [2, 3]
---

> **自动生成** 自 `src/mcp/server.ts` 的 `McpServer.listTools()`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。

`ymesh mcp` 启动一个 stdio JSON-RPC server，把 yondermesh 的 session 图暴露给任何支持 MCP 的 agent（Claude Code、Codex、Cursor、Gemini、Windsurf、Continue 等）。已废弃的转发别名不在此列。

**核心正交工具 8 个**，另有 5 个辅助工具（项目历史提取 / whoami）。

## 如何调用

### 从 CLI

```bash
ymesh mcp call <tool> [key=value ...]
```

## 核心工具（正交集）

### search_sessions

搜索本机所有 AI agent 的会话记录。可按时间范围、项目路径、agent 类型、会话类型过滤,并支持 query 关键字全文检索(匹配会话消息正文)。用于在开始新任务前查找是否有相关历史会话,回顾某个项目的全部工作记录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | no | 关键字全文检索,大小写不敏感,匹配会话消息正文 |
| `search` | string | no | 同 query(别名) |
| `source` | string | no | 按 agent 类型过滤(claude/codex/hermes 等),等价于旧参数 agent |
| `project_path` | string | no | 项目路径精确匹配 |
| `project_prefix` | string | no | 项目路径前缀 |
| `agent` | enum(claude / codex / opencode / hermes / kimi / cursor / copilot / gemini) | no | 按 agent 类型过滤(旧别名,等价 source) |
| `topology` | enum(root / subagent) | no | root=用户发起的真实会话，subagent=被其他 agent 调起的子会话 |
| `since` | string | no | 起始时间，ISO 8601 或相对时间如 7d / 24h / 30m |
| `limit` | number | no | 返回条数，默认 20 (default `20`) |

### get_session

获取指定会话的完整内容(消息记录)。支持 live 模式直读源文件获取实时内容、handoff_mode 任务接管模式,以及 include_relations 附带父子/关联会话拓扑。合并旧版 get_session_detail + get_session_relations + yondermesh_get_session。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | yes | 会话 ID |
| `live` | boolean | no | 直读源文件获取实时内容(运行中会话也能读到最新) |
| `limit` | number | no | 只返回最后 N 条消息 |
| `include_compacted` | boolean | no | live 模式附 codex 压缩摘要 (default `false`) |
| `include_tool_calls` | boolean | no | live 模式保留 function_call (default `false`) |
| `handoff_mode` | boolean | no | 等价于 live + compacted + tool_calls + 尾部 30 条 (default `false`) |
| `include_relations` | boolean | no | 附带父/子/关联会话拓扑 (default `false`) |

### list_active

列出当前活跃或等待用户审阅的 AI agent 会话。合并旧版 list_active_sessions + who_is_working + who_is_waiting,附 live/idle/stopped 计数与各 session 运行时摘要。直查数据库,反映最近扫描周期内的状态。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `within_minutes` | number | no | 查多少分钟内有活动的 session,默认 30 (default `30`) |
| `include_waiting` | boolean | no | 附带等待用户审阅的 session,默认 true (default `true`) |

### overview

获取本机全部 AI agent 会话的统计概览(总数/root/subagent/消息数等)。合并旧版 get_overview。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `since` | string | no | 只统计此时间之后的数据 |
| `project_prefix` | string | no | 只统计匹配的项目 |

### handoff

为任务接力生成浓缩 handoff 包。直读源文件,返回 codex 压缩后的 compacted 摘要、尾部近况、task_plan、session 元数据与活跃状态。合并旧版 get_session_handoff。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | yes | 会话 ID(必填) |
| `tail_messages` | number | no | 尾部含 tool call 的消息条数,默认 30 (default `30`) |

### send

同步向目标 agent CLI 会话注入一条用户消息并拿到回复。三种模式: new(新建会话)/running(注入运行中会话)/stopped(恢复已停止会话)。合并旧版 yondermesh_send + launch_agent + inject_session + transfer_session。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cli` | string | yes | 目标 CLI id(如 hermes/claude/opencode) |
| `message` | string | yes | 用户消息 |
| `mode` | enum(new / running / stopped) | no | 投递模式,默认 new (default `new`) |
| `session_id` | string | no | stopped/running 模式必填的目标 session id |
| `model` | string | no | 模型 id(可选) |
| `effort` | string | no | 推理强度(可选) |
| `cwd` | string | no | 工作目录(可选) |
| `timeout_ms` | number | no | 超时毫秒,默认 60000 |
| `from_session_id` | string | no | 发送方 session id(审计用) |

### mailbox

异步留言读写。通过 action 选择操作: post(发消息/广播)/check(读未读)/reply(回复)/get(查收)。合并旧版 post_message + get_messages + yondermesh_mailbox_*。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | enum(post / check / reply / get) | no | 操作,默认 check (default `check`) |
| `to_session_id` | string | no | post: 目标 session |
| `to_project` | string | no | post: 目标项目(广播) |
| `from_session_id` | string | no | post/reply: 发送方 |
| `body` | string | no | post/reply: 正文 |
| `kind` | enum(info / warning / question / task_update) | no | 消息类型 (default `info`) |
| `priority` | enum(low / normal / high / urgent) | no | 优先级 (default `normal`) |
| `reply_to_id` | number | no | reply: 被回复消息 ID |
| `self_session_id` | string | no | check/get: 显式自身 session |
| `mark_read` | boolean | no | check: 标记已读,默认 true (default `true`) |

### agents

列出本机 agent CLI 及其安装状态、采集等级、挂载能力,可选附带挂载详情。合并旧版 yondermesh_list_agents + yondermesh_mount_status。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `installed_only` | boolean | no | 只返回已安装的,默认 true (default `true`) |
| `include_mounts` | boolean | no | 附带各 CLI 挂载详情,默认 false (default `false`) |

## 辅助工具

### extract_project_history

提取指定项目所有 session 历史中的用户需求（user 消息）和 agent 响应（assistant 消息），分别存为可索引的 NDJSONL 文件。这是了解用户在某个项目上真实需求的第一步。force_refresh=false 且已有提取结果时直接返回现有统计不重新提取。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_path` | string | yes | 项目路径（cwd 前缀匹配） |
| `force_refresh` | boolean | no | true 时强制重新提取；false 且已有结果时直接返回现有统计 (default `false`) |

### query_user_requirements

查询某项目的用户需求（user 消息）。可按关键词、session、时间、ID 过滤。每条含 id、sessionId、content、timestamp。需先调用 extract_project_history 完成提取。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_path` | string | yes | 项目路径（需与 extract 时一致） |
| `keyword` | string | no | 关键词模糊匹配（大小写不敏感，匹配 content） |
| `session_id` | string | no | 按 session ID 过滤 |
| `from` | string | no | 起始时间，ISO 8601 或相对时间如 7d / 24h / 30m |
| `to` | string | no | 结束时间，ISO 8601 或相对时间 |
| `limit` | number | no | 返回条数上限，默认 20 (default `20`) |
| `offset` | number | no | 跳过前 N 条，默认 0 (default `0`) |
| `id` | number | no | 按精确 ID（=行号，1-based）查询，命中时忽略其它过滤 |

### query_agent_responses

查询某项目的 agent 响应（assistant 消息）。可按关键词、session、时间、ID 过滤。需先调用 extract_project_history 完成提取。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `project_path` | string | yes | 项目路径（需与 extract 时一致） |
| `keyword` | string | no | 关键词模糊匹配（大小写不敏感，匹配 content） |
| `session_id` | string | no | 按 session ID 过滤 |
| `from` | string | no | 起始时间，ISO 8601 或相对时间如 7d / 24h / 30m |
| `to` | string | no | 结束时间，ISO 8601 或相对时间 |
| `limit` | number | no | 返回条数上限，默认 20 (default `20`) |
| `offset` | number | no | 跳过前 N 条，默认 0 (default `0`) |
| `id` | number | no | 按精确 ID（=行号，1-based）查询，命中时忽略其它过滤 |

### yondermesh_whoami

Resolve your own session id via 3-layer fallback: (1) env YONDERMESH_SELF_SESSION_ID, (2) self_session_id arg, (3) match cwd against recently active sessions in the store. Also reports your current unread message count. Use this at the start of any task to know who you are and whether other agents have sent you messages.

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `self_session_id` | string | no | Explicitly pass your session id (fallback when env var is not set) |

### yondermesh_check_prior_attempts

Check whether other agents have encountered a similar task/error before and what they concluded. Input a task description or error message; returns ranked prior attempts with their conclusions (last assistant message preview). v0 uses deterministic matching on session messages (failure-marker regex + token overlap + same-project weighting) — zero LLM, no separate decision-extraction module. Useful before starting a new task to avoid re-stepping on a known landmine.

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | yes | Task description or error text to search for. Required. e.g. "TypeError: x is not a function" or "how to configure E2E sync". |
| `project_path` | string | no | Caller's project path. Sessions with the same projectPath get a relevance boost. Optional. |
| `cwd` | string | no | Caller's working directory. Sessions with the same cwd get a small relevance boost. Optional. |
| `limit` | number | no | Max results (default 5, max 50). (default `5`) |
| `min_score` | number | no | Minimum relevance score 0-1 (default 0.1). Lower = more results but noisier. (default `0.1`) |
