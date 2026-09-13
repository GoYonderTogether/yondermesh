---
title: MCP 工具
description: yondermesh MCP server（ymesh mcp）暴露的正交工具集参考 —— 参数与调用方式。
outline: [2, 3]
---

> **自动生成** 自 `src/mcp/server.ts` 的 `McpServer.listTools()`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。

`ymesh mcp` 启动一个 stdio JSON-RPC server，把 yondermesh 的 session 图暴露给任何支持 MCP 的 agent（Claude Code、Codex、Cursor、Gemini、Windsurf、Continue 等）。已废弃的转发别名不在此列。

**核心正交工具 4 个**（看 / 说 / 管 / 标）。

## 如何调用

### 从 CLI

```bash
ymesh mcp call <tool> [key=value ...]
```

## 核心工具（正交集）

### observe

看——统一的查询与分析入口。scope 选看哪儿（me 我自己 / global 全局总览 / project 整个项目 / session 某个会话 / active 谁在干活 / tree 会话树），filter 只要什么，shape 决定形态。筛选是查询的一部分，不用后处理：只看人的话用 roles:["user","assistant"]；只要长需求用 min_length:200；排掉工具噪音用 exclude:["tool"]。合并旧版 search_sessions / get_session / list_active / overview / extract_project_history / query_user_requirements / query_agent_responses / agents / whoami。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scope` | enum(me / global / project / session / active / tree) | yes | 看哪儿，默认 global |
| `target` | string | no | scope=session/tree 给 session id；scope=project 给项目路径 |
| `shape` | enum(list / detail / summary / tree / stats) | no | 要什么形态 |
| `roles` | array | no | 只要这些角色：user / assistant / system / tool |
| `exclude` | array | no | 排除这些角色，如 ["tool"] |
| `min_length` | number | no | 只要内容长度 &gt;= 这个字数的 |
| `keyword` | string | no | 关键词模糊匹配 |
| `since` | string | no | 这个时间之后，支持 7d / 24h / 30m 或 ISO |
| `until` | string | no | 这个时间之前 |
| `limit` | number | no | 最多几条，默认 20 (default `20`) |
| `offset` | number | no | 翻页用，默认 0 (default `0`) |
| `include_agents` | boolean | no | scope=global 时附带 CLI 列表 (default `false`) |
| `self_session_id` | string | no | 显式指定自己的 session（scope=me） |

### message

说——跟其他 agent 会话通信的唯一入口。不需要知道对方是哪个 CLI，只给 session id。action=send 发 / check 看发给我的。delivery 决定时机：now 立刻发（目标正在跑会被拒绝，外部注入会与它自己双写损坏会话）；after_turn 等我这轮结束再发（积压合并成一条）；on_reply 等对方回复完用户那一刻、以用户口吻发给它。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | enum(send / check) | yes | send=发 / check=看，默认 check (default `check`) |
| `to` | string | no | send: 目标 session id（支持 hash / native / 前缀），或 "all" 广播（广播按收件人记已读：同项目多个 agent 各自都能看到，不会被先读的人吃掉） |
| `body` | string | no | send: 消息正文 |
| `delivery` | enum(now / after_turn / on_reply) | no | send: 投递时机，默认 now (default `now`) |
| `reply_to` | number | no | send: 回复某条消息的 id |
| `limit` | number | no | check: 最多几条，默认 20 (default `20`) |
| `mark_read` | boolean | no | check: 读完标已读，默认 true (default `true`) |
| `unread_only` | boolean | no | check: 只看未读，默认 true (default `true`) |
| `self_session_id` | string | no | check: 显式自己的 session |

### orchestrate

管——我作为上级对下属 agent 的动作。action 选树上的操作：spawn 起新会话（可编排 config.cli/model/effort/cwd，cwd 强烈建议给）；assign 把活派给已有会话（别重复起新的）；handoff 生成接力包交给另一个 agent；await 等某个会话出结果；discuss 拉多个会话互相讨论（必须给不同 model，否则是同一张嘴说三遍）；prior 这事以前有人试过吗；stop 协作式叫停（不是 kill —— ymesh 不持有进程句柄，让目标自己收手）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | enum(spawn / assign / handoff / await / discuss / stop / prior) | yes | 要做什么 |
| `target` | string | no | assign/await/handoff 的目标 session id |
| `brief` | string | no | 任务描述（spawn/assign/discuss 用） |
| `to` | array | no | discuss: 拉哪几个会话进来（&gt;=2） |
| `query` | string | no | prior: 要查的任务/报错文本 |
| `delivery` | enum(now / after_turn / on_reply) | no | assign/discuss 的投递时机，默认 on_reply |
| `config` | object | no | spawn 的执行配置 |
| `limit` | number | no | tail/handoff 条数，默认 30 |
| `self_session_id` | string | no | 发送方 session id |

### workspace

标——工作目录的归属与分组（写人的判断，不是读 agent 状态）。project_path 只能从 CLI 的 cwd 自动推出来，但「这几个目录属于同一摊事」「这目录我叫它笔记库」是人的判断，机器推不出来，所以需要能写。add/update 标记（label 起名 / group 分组 / note 备注）；list 看已标记；status 看每个标记目录下现在有哪些 agent 在跑；remove 取消标记（不动会话）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | enum(list / add / update / remove / status) | yes | 做什么 |
| `path` | string | no | 工作目录绝对路径 |
| `label` | string | no | 给它起个名字，如「笔记库」 |
| `group` | string | no | 归到哪一组，如「个人」/「工作」 |
| `note` | string | no | 备注 |
| `within_minutes` | number | no | status: 只看最近多久的会话，默认 30 (default `30`) |
