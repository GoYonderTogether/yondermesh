---
title: Daemon
description: yondermesh daemon 通过扫描 / 监听 / reconcile 循环从 CLI 原生文件采集 session。介绍如何启动、作为服务运行与诊断。
outline: [2, 3]
---

# Daemon

yondermesh daemon 是保持本地 SQLite store 与 CLI 代理写入内容同步的后台进程。它只读取原生文件——绝不修改它们。

## Daemon 做什么

Daemon 运行 scan-once + watch + reconcile 循环（实现于 `src/daemon/index.ts`，类 `YondermeshDaemon`）：

```text
start → scan-once → watch (fs events) → periodic reconcile → idle
```

- **scan-once**——启动时每个已注册的 importer 各运行一次。`cass` 在每个 daemon 生命周期内只扫描一次（它不是实时数据源）；`claude` 与 `codex` 在每次 reconcile 时也会扫描。
- **watch**——`fs.watch`（macOS 上递归模式）监听 Claude 与 Codex 的 session 目录。文件变更事件在触发受影响来源的增量扫描前会被防抖（`debounceMs`，默认 1 秒）。检测到新入库的 session 时，daemon 会输出一行 stderr 日志。
- **periodic reconcile**——`setInterval` 每 `reconcileIntervalMs`（默认 60 秒）运行一次 `fullScan()`。这是对没有可监听 session 目录的 CLI（Cursor、Gemini、Windsurf、Trae 在内部存储 session）以及任何 fs.watch 遗漏的安全兜底。若 `autoMount` 开启（默认），reconcile 还会幂等地重新应用挂载。

Daemon 通过 PID 文件持有单实例锁。若已有活跃 daemon 在运行，`start()` 会抛错而非重复扫描。

Daemon 绝不修改原生 CLI 文件。它只通过各 adapter 的 importer 读取。该不变式的含义见 [架构](/zh/guide/architecture)。

## 启动 daemon

用 `ymesh daemon` 在前台运行：

```bash
ymesh daemon
```

进程保持附着在你的终端上。用 `Ctrl+C`（SIGINT）或 `kill <pid>`（SIGTERM）停止——两者都触发优雅的 `stop()`：清理防抖定时器、关闭所有 `fs.FSWatcher` 句柄、清理 reconcile 定时器、释放 PID 锁、关闭 SQLite store。

若 daemon 崩溃或被杀掉而未释放 PID 文件，下一次 `start()` 会探测到存储的 PID 已不再存活（通过 `process.kill(pid, 0)` 探测）并回收锁。

## 作为服务运行

若需常驻运行，把 daemon 安装为系统服务：

```bash
# 安装为 LaunchAgent（macOS）
ymesh service install

# 管理服务
ymesh service start
ymesh service stop
ymesh service status

# 移除服务
ymesh service uninstall
```

在 macOS 上，`ymesh service install` 注册一个 LaunchAgent，登录时启动 daemon 并在崩溃时重启。`ymesh service status` 报告 agent 是否已加载、daemon 进程是否存活。

## Daemon 配置

Daemon 从 `src/daemon/config.ts` 定义的默认值读取配置，可通过 `DaemonConfig` 接口覆盖：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataDir` | `~/.yondermesh`（或 `$YONDERMESH_HOME`） | DB、PID 文件等的数据目录。 |
| `dbPath` | `<dataDir>/yondermesh.db` | SQLite 数据库文件。 |
| `pidFile` | `<dataDir>/daemon.pid` | 单实例锁文件。 |
| `reconcileIntervalMs` | `60000`（1 分钟） | 定时全量扫描间隔。 |
| `debounceMs` | `1000`（1 秒） | 监听事件防抖延迟。 |
| `deviceId` | `os.hostname()` | 写入 session 的设备标识。 |
| `autoMount` | `true` | reconcile 后及检测到新 session 时重新应用挂载。 |
| `skipCass` / `skipClaude` / `skipCodex` | `false` | 按来源跳过的开关。 |

### 覆盖数据目录

设置 `YONDERMESH_HOME` 环境变量可整体迁移数据目录（DB、PID 文件、配置、日志、briefing）：

```bash
export YONDERMESH_HOME=/var/lib/yondermesh
ymesh daemon
```

`src/daemon/config.ts` 的 `defaultDataDir()` 在设置了 `YONDERMESH_HOME` 时解析为该值，否则回退到 `~/.yondermesh`。

面向用户的配置文件是 `~/.yondermesh/config.yaml`（完整 schema 见 [配置文件](/zh/reference/config)）。

## 定时 reconcile 间隔

reconcile 间隔（`reconcileIntervalMs`）是 daemon 即使没有 fs.watch 事件也会重新运行 `fullScan()` 的节奏。默认 60 秒是在新鲜度与成本之间的平衡。

按需调整：

- **更短**（如 15 秒）——更快拾取无可监听目录的 CLI（Cursor、Gemini、Windsurf、Trae）的 session，代价是更多扫描。
- **更长**（如 5 分钟）——更低的后台 CPU，代价是不可监听 CLI 的可见性更慢。

对于有可监听目录的 CLI（Claude Code、Codex），无论 reconcile 间隔如何，更新都通过 fs.watch 近乎实时地被拾取——reconcile 只是兜底。

## 查询 daemon 状态

`ymesh status` 报告 daemon 是否在运行、其 PID、数据目录、监听路径、最近一次扫描结果以及任何监听错误：

```bash
ymesh status
```

状态快照（`src/daemon/index.ts` 中的 `DaemonStatus` 类型）从 PID 文件与持久化的 `watched-paths.json` 文件读取——CLI 与 daemon 是两个独立进程，因此 daemon 在启动时把监听路径列表写入磁盘，在停止时清理。

若无 daemon 运行，`ymesh status` 会说明并以非零退出码退出。

## Doctor 诊断

`ymesh doctor` 跨安装、数据库、daemon、日志运行完整健康检查：

```bash
ymesh doctor
```

它检查：

- **安装**——`ymesh` 二进制可解析、release 符号链接完好、当前 release 未损坏。
- **数据库**——`yondermesh.db` 可读、schema 存在、行数合理。
- **Daemon**——PID 文件存在、存储的 PID 仍存活、最近一次扫描无错误完成。
- **日志**——近期日志行存在且无意外错误模式。

当感觉哪里不对时，把 `ymesh doctor` 作为第一步——它会定位是哪一层出了问题。

## 日志与轮转

Daemon 向 stderr 写单行进度信息（如 `[yondermesh] 新 session 检测到: claude <id>`）。前台运行时，这些输出到你的终端。作为 LaunchAgent 运行时，macOS 把它们捕获到 `~/Library/Logs/yondermesh/`。

没有内置日志轮转——LaunchAgent plist 依赖 macOS 对 LaunchAgent stderr/stdout 捕获的标准轮转。若你在进程管理器（launchd、systemd、supervisord）下运行 daemon，请在该层配置轮转。

## 相关

- [跨设备同步](/zh/guide/sync)——搭载于 daemon store 之上的同步 agent。
- [Session 与拓扑](/zh/guide/sessions)——daemon 采集进的是什么。
- [文件布局](/zh/reference/files)——`src/daemon/` 文件的规范映射。
- [架构](/zh/guide/architecture)——daemon 生命周期在三个平面语境中的位置。
