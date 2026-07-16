---
title: Session 与拓扑
description: Session 是 yondermesh 中上下文的单位。介绍 session 的属性、拓扑类型、source 别名，以及如何查询与交接 session。
outline: [2, 3]
---

# Session 与拓扑

Session 是 yondermesh 中上下文的单位。系统所做的一切——采集、查询、同步、交接——都围绕 session 展开。本页描述 session 是什么、它携带的属性，以及查询它们的 CLI 接口。

## Session 是什么

Session 是一次 CLI 代理运行：一次 Claude Code 对话、一次 Codex session、一次 Aider git-log 运行等。每个 session 都由 adapter（JSONL、session DB、git log 等的读取者）从 CLI 原生格式中**采集**，并通过 `SessionStore` **upsert 进本地 SQLite**。

唯一标识一个 session 的 canonical 身份三元组是：

```text
device_id + source_instance_id + native_session_id
```

`source_instance_id` 标识设备上的一个采集入口（例如一个 Claude Code 安装的 `~/.claude/projects` 目录）。正是这个三元组让 session 唯一——绝不仅凭 CLI 名称加 session id，因为同一个原生 session id 可能出现在不同的 source instance 或设备下。

SQLite schema（见 `src/store/schema.ts`）将 session 存储在 `sessions` 表中，消息历史在 `session_revisions` 与 `messages` 中，关系在 `session_relationships` 中，扫描簿记在 `scan_runs` 中。`src/store/` 是唯一写入者；adapter 绝不直接触碰 SQL。

## Session 属性

每个 `SessionRecord`（定义于 `src/store/types.ts`）携带：

| 属性 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | yondermesh session id（UUID）。 |
| `deviceId` | `string` | 采集该 session 的设备。 |
| `sourceInstanceId` | `string` | 产生它的采集入口。 |
| `nativeSessionId` | `string` | CLI 自身的 session id（如 Claude JSONL UUID）。 |
| `source` | `string` | Canonical source id（`claude`、`codex`……）。 |
| `cwd` | `string \| null` | CLI 被调用时的工作目录。 |
| `projectPath` | `string \| null` | 项目根目录（若可与 `cwd` 区分）。 |
| `topology` | `SessionTopology` | `root` / `subagent` / `sidechain`（见下文）。 |
| `presence` | `Presence` | `present` / `missing` / `unknown`。 |
| `retention` | `Retention` | `live` / `archived` / `purged`。 |
| `contentHash` | `string` | 当前 revision 内容的哈希。 |
| `currentRevisionId` | `number \| null` | 指向 `session_revisions` 的指针。 |
| `messageCount` | `number` | 当前 revision 中的消息数。 |
| `startedAt` | `number \| null` | session 开始的 epoch 毫秒。 |
| `lastSeenAt` | `number` | 最近一次触碰它的扫描的 epoch 毫秒。 |
| `model` | `string \| null` | 模型名称（若 CLI 暴露）。 |
| `cliVersion` | `string \| null` | CLI 版本字符串。 |
| `estimatedCostUsd` | `number \| null` | 预估花费（若可用）。 |
| `totalInputTokens` / `totalOutputTokens` / `toolCallCount` | `number \| null` | token 与工具调用计数。 |

`presence` 与 `retention` 是正交的状态轴——它们并不相互推导。一个 session 可以是 `present` + `archived`（原生文件仍存在，但该 session 被跨源重复项去重了）。

## 拓扑类型

每个 session 都有一个 `topology`（类型 `SessionTopology`，见 `src/store/types.ts`）：

- **`root`**——顶层代理 session。这是默认值。未显式请求 subagent 的查询只返回 root，所以 `ymesh sessions` 展示的是你真正进行过的对话，而非内部的子代理调用。
- **`subagent`**——由另一个 session 派生的 session（如 Claude Code 的 Task 工具派生子代理）。关系记录在 `session_relationships` 中，`relation_type = 'spawned_by'`。
- **`sidechain`**——与 root session 并行运行、但并非严格由其派生的 session（如一次侧边对话、一次并行探索）。以 `relation_type = 'sidechain_of'` 记录。

完整的 `RelationType` 取值：`spawned_by`、`sidechain_of`、`continued_from`、`import_alias_of`、`derived_from`。关系被建模在独立的表中，而非塞进一个 `parent_id` 列——这让一个 session 可以拥有多个有类型的关系，而无需 schema 翻新。

## Source 别名

原始 source 名称是混乱的。Claude Code 在某些地方写 `claude-code`，在另一些地方写 `ClaudeCode`；cass 从数据库读到 `claude_code`。yondermesh 在写入时把所有这些都归一化为单个 canonical id，并在查询时把 canonical id 展开回所有已知别名——所以 `--source claude` 能命中所有拼写。

映射位于 `src/store/source-aliases.ts`。若干代表性条目：

| 原始别名 | Canonical |
|---|---|
| `claude`、`claude-code`、`claude_code`、`claudecode` | `claude` |
| `codex` | `codex` |
| `opencode`、`open-code`、`open_code` | `opencode` |
| `gemini`、`gemini-cli`、`gemini_cli` | `gemini` |
| `continue`、`cn`、`continue-cli`、`continuedev` | `continue` |
| `cline`、`cline-cli`、`clinecli` | `cline` |
| `trae-cli`、`trae_cli`、`traecli` | `trae_cli`（与 Trae IDE 的 `trae` 严格区分） |
| `factory`、`factory-droid`、`droid` | `factory` |

两个函数承担工作：

- `normalizeSource(raw)`——在导入时调用；返回 canonical id。未知 source 原样返回，不丢失信息。
- `expandSource(canonical)`——在查询时调用；返回所有映射到该 canonical id 的别名，使 SQL `IN (...)` 子句能命中所有拼写。

未知的 source 名称不会被丢弃——原样透传，这意味着含非 canonical 名称的旧数据在下次扫描归一化之前仍然可查询。

## 查询 session

`ymesh sessions` 列出 session 并支持过滤。所有过滤器都是可选的，以 AND 语义组合。

```bash
# 跨所有来源的最新 20 条 session
ymesh sessions

# 按来源过滤（canonical 名称；别名自动展开）
ymesh sessions --source claude

# 按拓扑过滤（默认仅 root）
ymesh sessions --topology subagent

# 按工作目录过滤
ymesh sessions --cwd /Users/zoran/projects/foo
ymesh sessions --cwd-prefix /Users/zoran/projects

# 按项目路径过滤
ymesh sessions --project /Users/zoran/projects/foo

# 时间窗口（epoch 毫秒或 ISO 8601）
ymesh sessions --from 2025-01-01 --to 2025-02-01

# 包含被跨源去重的 session
ymesh sessions --include-archived

# 机器可读输出
ymesh sessions --source codex --json
```

完整过滤集（来自 `src/store/types.ts`，`SessionQuery`）：

| 标志 | 映射到 | 行为 |
|---|---|---|
| `--source` | `source` | Canonical source；别名经 `expandSource` 自动展开。 |
| `--topology` | `topology` | `root` / `subagent` / `sidechain`。 |
| `--cwd` | `cwd` | 工作目录精确匹配。 |
| `--cwd-prefix` | `cwdPrefix` | 前缀匹配，目录边界安全（LIKE 特殊字符已转义）。 |
| `--project` | `projectPath` | 项目路径精确匹配。 |
| `--from` | `startedAtFrom` | `startedAt` 的闭区间下界。 |
| `--to` | `startedAtTo` | `startedAt` 的闭区间上界。 |
| `--limit` | `limit` | 结果上限（默认 20）。 |
| `--include-archived` | `includeArchived` | 包含 `retention = 'archived'` 的 session。默认 false。 |

查询默认返回 `retention = 'live'` 的 session。要查看被跨源去重标记为 `archived` 的 session，请传 `--include-archived`。

## 活跃 session

`ymesh active` 回答“谁正在干活？”。它返回 `lastSeenAt` 落在活跃窗口内（近期扫描活动）的 session，并为在活跃阈值内仍在写入的 session 标记 `isLive`。

```bash
ymesh active
```

输出是 `src/store/types.ts` 中的 `ActiveSummary` 形态：活跃 session 计数、live（正在写入）session 计数、按来源的细分，以及按 `lastSeenAt` 倒序排列的逐 session 列表。这与 MCP 工具 `who_is_working` 背后的数据相同。

## 跨源去重

同一个物理 session 可能被两个不同的 importer 采集——最常见的是 cass（从 cass 数据库读取的 B 级兼容 importer）和原生 A 级 adapter（如 Claude Code JSONL importer）都看到同一次 Claude session。若不去重，你会看到它两次。

`SessionStore.deduplicateCrossSource` 折叠这些重复项。匹配键是 `normalized_source + canonical_id`，其中 `canonical_id` 是从 `native_session_id` 中提取的 UUID（见 `src/store/source-aliases.ts` 的 `extractCanonicalId`）。当两个 session 共享匹配键时，覆盖等级较高者（A 优于 B）保持 `live`；另一个被标记为 `retention = 'archived'`。归档的 session 在默认查询中被排除——传 `--include-archived` 可查看。

## 提取与交接

两个命令把 session 转成可移植制品：

- **`ymesh extract`** 把一个项目的所有 user 需求与 assistant 响应转储为 NDJSONL 文件（按类型分文件），按行号与 session id 索引。支撑语料导出与离线分析。见 `src/extract/`。
- **`ymesh handoff <id>`** 为单个 session 构造 `HandoffPackage`——压缩摘要加近期消息加任务计划——让代理 B 接手代理 A 留下的工作。同一构造器支撑 `get_session_handoff` MCP 工具。见 `src/mcp/codex-handoff.ts`。

两个命令都接受共享的过滤标志（`--source`、`--cwd-prefix`、`--project`、`--from`、`--to`、`--limit`）。完整标志列表见 [CLI 参考](/zh/reference/cli)。

## 相关

- [Daemon](/zh/guide/daemon)——session 如何被采集：扫描 / 监听 / reconcile 循环。
- [CLI 命令](/zh/reference/cli)——完整的 `ymesh` 命令面，由 `ymesh help` 自动生成。
- [MCP Server](/zh/guide/mcp)——向代理暴露 session 的 MCP 工具（`search_sessions`、`list_active_sessions`、`get_session_handoff`、`who_is_working`……）。
- [架构](/zh/guide/architecture)——三个平面与治理 session 存储的不变式。
