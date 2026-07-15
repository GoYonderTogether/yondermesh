---
title: 架构
description: yondermesh 的鸟瞰视图——三个平面、daemon 生命周期、模块布局，以及维系系统的架构不变式。
outline: [2, 3]
---

# 架构

yondermesh 是一个自托管的 **Agent Context Bus（代理上下文总线）**：一个 daemon 加一个 MCP server，让你的 AI 编码代理跨设备、跨 CLI 共享同一工作面。Session 从各 CLI 的原生格式中被采集进本地 SQLite；MCP server 向任何支持 MCP 的代理暴露查询与交接工具；跨设备同步仅以密文形式经过自托管 relay。

## 概览

yondermesh 运行在 **三个互不交叉污染的平面** 上。让这三个平面保持分离，是代码库中最重要的设计决策——正是它让系统具备非侵入性。

```text
Local plane        CLI native files → adapter → SessionStore (SQLite) → MCP server (stdio)
Sync plane         SessionStore → relay agent → self-hosted relay (ciphertext only) → peer device
Mount plane        ymesh skills / MCP config → CLI's own config dir (~/.claude/, ~/.codex/, ~/.cursor/, …)
```

- **Local plane（本地平面）** 读取各 CLI 写入的内容并将其转化为结构化查询。Adapter 是纯读取者，绝不修改原生文件。
- **Sync plane（同步平面）** 在你自己的设备之间搬运上下文。离开设备的永远是密文——relay 永远看不到明文。
- **Mount plane（挂载平面）** 把 ymesh 扩展（MCP server 配置、skill 符号链接、always-on 段落）安装进各 CLI 自己的配置目录。它编辑的是配置文件，绝不触碰二进制。

CLI 本身（`ymesh`）是对 daemon 写入的同一个 `SessionStore` 的薄封装。`ymesh scan`、`ymesh sessions`、`ymesh active` 都是直接的 store 查询——只读命令没有独立的 daemon 协议。

## 架构图

```text
┌─────────────────────────────────────────────────────┐
│  Device A (macOS)                                   │
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
                                           │ E2E encrypted
                              ┌────────────┴────────────┐
                              │   Self-hosted relay     │
                              │   (ciphertext only)     │
                              └────────────┬────────────┘
                                           │
┌──────────────────────────────────────────┼────────────┐
│  Device B (Windows)                      │            │
│  ┌──────────┐  ┌──────────┐  ┌───────────┴──────────┐ │
│  │  Codex   │  │  Aider   │  │  yondermesh daemon   │ │
│  │  session │  │  git log │  │  queries Device A    │ │
│  └──────────┘  └──────────┘  └──────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

每台设备运行各自的 daemon。设备之间通过自托管 relay 配对，relay 仅承载密文。任何云都看不到明文；relay 不是被信任的参与方。

## 核心心智模型

yondermesh 中上下文的单位是 **session**。一个代理的 session 是被采集、被查询、被同步、被交接的对象。每个 MCP 工具都是对 session 图的一次结构化查询；每个 adapter 都是某个 CLI 原生 session 格式的一个读取者。

一个 session 携带三个正交的身份轴：

- **source**——由哪个 CLI 产生，归一化为 canonical ID（`claude`、`codex`、`cass`、`hermes`、`continue`、`windsurf`……）。像 `claude-code` 或 `ClaudeCode` 这样的原始名称会被 `src/store/source-aliases.ts` 折叠为 `claude`。
- **topology**——session 在代理调用树中的角色：`root`、`subagent` 或 `sidechain`。
- **project**——`cwd` 与 `projectPath`，便于查询按工作目录或项目根目录限定范围。

在此之上，每个 session 还有两个正交的状态轴：

- **presence**——`present` / `missing` / `unknown`（原生文件是否仍存在于磁盘）。
- **retention**——`live` / `archived` / `purged`（session 是否仍活跃、被去重归档、或已被清理）。

唯一标识一个 session 的 canonical 身份三元组是 `device_id + source_instance_id + native_session_id`——绝不仅凭 CLI 名称和 session id。完整属性列表见 [Session 与拓扑](/zh/guide/sessions) 页面。

## Daemon 生命周期

Daemon 运行如下循环（定义在 `src/daemon/index.ts`，类 `YondermeshDaemon`）：

```text
start → scan-once → watch (fs events) → periodic reconcile → idle
```

1. **start**——`acquireLock()` 写入 PID 文件以强制单实例。若已有活跃 daemon 在运行，`start()` 会抛错。
2. **scan-once**——`fullScan()` 依次运行所有已注册的 importer。`cass` 在每个 daemon 生命周期内只扫描一次（它不是实时数据源）；`claude` 与 `codex` 在每次 reconcile 时都扫描。
3. **watch**——`fs.watch`（macOS 上递归模式）监听 Claude 与 Codex 的 session 目录。文件变更事件在触发受影响来源的增量扫描前会被防抖（`debounceMs`，默认 1 秒）。
4. **periodic reconcile**——`setInterval` 每 `reconcileIntervalMs`（默认 60 秒）运行一次 `fullScan()`。这是对没有可监听 session 目录的 CLI（Cursor、Gemini、Windsurf、Trae 在内部存储 session）以及任何 fs.watch 遗漏的安全兜底。
5. **idle**——扫描之间 daemon 持有锁并保持 watcher 存活。`SIGINT` / `SIGTERM` 会触发 `stop()`。

`stop()` 是优雅的：清理防抖定时器、关闭所有 `fs.FSWatcher` 句柄、清理 reconcile 定时器、释放 PID 锁、关闭 SQLite store。运维细节见 [Daemon](/zh/guide/daemon)。

## 模块布局

`src/` 下的源码树按职责组织。下表是一个摘要；规范且始终保持最新的文件映射见 [`ARCHITECTURE.md`](https://github.com/GoYonderTogether/yondermesh/blob/main/ARCHITECTURE.md) 与 [文件布局](/zh/reference/files) 参考。

| 目录 | 职责 |
|---|---|
| `src/bin/` | CLI 入口（`ymesh.ts`）。纯手写 `parseArgs`，无 CLI 框架。通过 `main()` 的 switch 分发命令。 |
| `src/`（各 adapter） | 每个受支持的 CLI 一个目录（`aider`、`claude`、`codex`、`cass`、`gemini`、`windsurf`……）。每个 adapter 遵循 `importer.ts` / `wrapper.ts` / `inject.ts` / `extractor.ts` 文件模式。 |
| `src/store/` | SQLite 的唯一写入/读取者。`SessionStore` 类、schema、类型、source 别名、去重逻辑。 |
| `src/daemon/` | `YondermeshDaemon` 生命周期 + `defaultDaemonConfig` / `defaultDataDir`。 |
| `src/mcp/` | `McpServer`（stdio JSON-RPC）+ 注册到 Claude Code 与 Codex + handoff 包构造器。 |
| `src/mount/` | Mount 系统：把 ymesh 扩展安装进各 CLI 配置目录，不修改 CLI 本身。 |
| `src/install/` | Release 构建、launcher 符号链接、git updater、skill linker、路径解析。 |
| `src/extract/` | `ymesh extract`——把 user 需求与 assistant 响应转储为 NDJSONL 文件。 |
| `src/briefing/` | 每日摘要生成器（输出到 `~/.yondermesh/briefings/`）。 |
| `src/sync/` | 跨设备同步 agent（仅密文）。 |

几条横切规则维持了边界清晰：

- `src/store/` 是 SQLite 的唯一写入者。Adapter 调用 `SessionStore` 方法，绝不直接写 SQL。
- `src/bin/ymesh.ts` 是唯一注册命令的地方。新增命令即在 `main()` 中加一个 `case` 加一个 `cmd*` 函数。
- `src/mount/` 绝不从 `src/<adapter>/` 导入。Mount 策略由 CLI 配置驱动，而非由 adapter 代码驱动。
- `scripts/docs/` 绝不从 `src/` 导入。它通过 `ymesh help` 调用并把 `src/*/` 当作纯文件读取，使文档生成器与内部重构解耦。

## 架构不变式

这些不变式由代码结构与 CI（`scripts/docs/check-drift.mjs`、`scripts/docs/verify-links.mjs`）强制执行。违反任意一条都算 bug。

1. **不修改 CLI。** Adapter 读取原生文件；mount 写入 CLI 自己的配置目录，但绝不修补 CLI 二进制或其 session 写入器。
2. **不做模型代理。** yondermesh 绝不触碰 API key。CLI 运行模型；ymesh 只读取 CLI 写入的内容。
3. **不锁定云。** 同步 relay 可自托管。云 relay 只是可选的便利，且永远看不到明文。
4. **无 UI。** 配置文件驱动；daemon 无头运行。本站点供人类阅读 yondermesh 文档，不是用来操作它的。
5. **拓扑感知。** 每个 session 都有拓扑（`root` / `subagent` / `sidechain`）。未显式请求 subagent 的查询默认只返回 root。
6. **source 规范化。** 每个 session 都有 canonical source ID（`claude`，而非 `ClaudeCode` 或 `claude-code`）。`src/store/source-aliases.ts` 在写入时归一化、在查询时展开。
7. **文档滞后 = bug。** 代码变更必须与文档变更在同一提交中发布。`check-drift.mjs` 与 `verify-links.mjs` 在 CI 中强制执行。

CLI 是 `SessionStore` 的薄封装，这是不变式 1 与 4 的必然推论：只读命令不需要 daemon RPC，因为 store 是唯一状态且它是本地 SQLite。

## 相关

- [Session 与拓扑](/zh/guide/sessions)——session 数据模型、属性列表与查询面。
- [Daemon](/zh/guide/daemon)——daemon 运维：前台运行、服务安装、状态、doctor。
- [跨设备同步](/zh/guide/sync)——同步 agent、relay 部署与仅密文不变式。
- [文件布局](/zh/reference/files)——`src/` 下每个文件的规范、始终保持最新的映射。
- [CLI 命令](/zh/reference/cli)——完整的 `ymesh` 命令面。
