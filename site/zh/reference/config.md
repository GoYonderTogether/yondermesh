---
title: 配置文件
description: yondermesh config.yaml 完整参考 — devices、sync、mcp、briefing、daemon 调优以及运行时环境变量。
outline: [2, 3]
---

# 配置文件

yondermesh 由配置文件驱动。daemon、MCP server、sync agent 与 briefing 生成器都从同一个 YAML 文件 `~/.yondermesh/config.yaml` 读取配置。本页文档化每个段落与字段。

## 配置文件位置

配置文件位于 `<data-dir>/config.yaml`。默认数据目录是 `~/.yondermesh/`，可通过 `YONDERMESH_HOME` 环境变量覆盖。

| 设置项 | 默认值 | 覆盖方式 |
|---|---|---|
| 数据目录 | `~/.yondermesh` | `YONDERMESH_HOME=/path/to/dir` |
| 配置文件 | `<data-dir>/config.yaml` | （无 — 始终位于数据目录内） |
| SQLite 数据库 | `<data-dir>/yondermesh.db` | `--db <path>` CLI 参数 |
| PID 文件 | `<data-dir>/daemon.pid` | `--pid-file <path>` CLI 参数 |

`ymesh init` 会生成带合理默认值的初始配置。升级后再运行一次以暴露任何新字段。`--db` 和 `--pid-file` 是单次调用级别的覆盖，不会写回配置文件。

## 完整示例

```yaml
# 监控的设备与 agent
devices:
  - name: macbook
    agents:
      - type: claude-code
        path: ~/.claude/projects
      - type: codex
        path: ~/.codex/sessions
      - type: aider
        path: ~/projects/myapp       # aider 通过 cwd 下的 git log 读取

# 跨设备同步（自建或使用官方云中继）
sync:
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem   # 首次运行自动生成

# MCP server
mcp:
  enabled: true
  port: 0                           # 0 = stdio 模式（默认）

# 每日简报
briefing:
  enabled: true
  output: ~/.yondermesh/briefings

# daemon 调优（可选 — 以下为默认值）
daemon:
  reconcile_interval_ms: 60000      # 定时全量扫描间隔
  debounce_ms: 1000                 # 文件系统事件去抖
  auto_mount: true                  # 在新 session 出现时自动挂载扩展
  skip_cass: false                  # 跳过 cass adapter（如 DB 不存在）
  skip_claude: false
  skip_codex: false
```

## devices

设备列表，以及要从每台设备采集的 agent session。每个设备有一个友好 `name` 和 `agents` 数组；每个 agent 条目告诉 yondermesh 使用哪个 adapter 以及原生 session 文件的位置。

```yaml
devices:
  - name: macbook
    agents:
      - type: claude-code
        path: ~/.claude/projects
      - type: codex
        path: ~/.codex/sessions
  - name: winbox
    agents:
      - type: gemini
        path: ~/.gemini
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `devices[].name` | string | 是 | 友好设备标识（用于 briefing、sync 日志） |
| `devices[].agents[].type` | string | 是 | Adapter ID。完整列表见 `/reference/adapters`（`claude-code`、`codex`、`aider`、`gemini`、`cursor`、`windsurf`、`trae`、`continue`、`cass`、`hermes`、`opencode`、`kimi` 等） |
| `devices[].agents[].path` | string | 是 | CLI 原生 session 目录的绝对路径。`~` 会被展开。 |

adapter `type` 会映射到 store 内部的规范 source ID（例如 `claude-code` -> `claude`）。别名由 `src/store/source-aliases.ts` 统一规整。

## sync

跨设备同步配置。当此段存在时，daemon 的 sync agent 用本地密钥加密新 session，将密文推送到 relay；对端更新被拉取并在另一侧解密。

```yaml
sync:
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sync.relay_url` | string | 是 | 自建 relay 的 HTTPS URL。云中继为可选便利服务，绝不接触明文。 |
| `sync.key_file` | string | 是 | E2E 加密密钥（PEM）路径。缺失时首次运行自动生成。 |

架构不变量：只有密文离开设备。relay 协议与自建方式见 `/guide/sync`。

## mcp

MCP server 配置。yondermesh 默认使用 stdio JSON-RPC — agent 通过 `command: ymesh, args: ["mcp"]` 接入。

```yaml
mcp:
  enabled: true
  port: 0   # 0 = stdio（默认）；>0 = TCP 监听
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mcp.enabled` | boolean | `true` | daemon 是否拉起 MCP server |
| `mcp.port` | number | `0` | `0` = stdio JSON-RPC（推荐）。正值则绑定 TCP 端口用于 HTTP/SSE 客户端。 |

完整工具列表见 `/reference/mcp-tools`；注册到 Claude Code、Codex、Cursor 等的方式见 `/guide/mcp`。

## briefing

每日摘要生成器。生成过去 24 小时跨所有设备的 agent 活动人类可读摘要。

```yaml
briefing:
  enabled: true
  output: ~/.yondermesh/briefings
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `briefing.enabled` | boolean | `true` | daemon 是否写每日 briefing |
| `briefing.output` | string | `~/.yondermesh/briefings` | 按日期命名的 briefing 文件输出目录 |

## daemon

daemon 扫描/监听循环的可选调优旋钮。所有字段默认值如下所示；省略整段即接受默认。这些字段对应 `src/daemon/config.ts` 中的 `DaemonConfig`。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `daemon.reconcile_interval_ms` | number | `60000` | 定时全量扫描间隔（毫秒） |
| `daemon.debounce_ms` | number | `1000` | 文件系统事件去抖延迟（毫秒） |
| `daemon.auto_mount` | boolean | `true` | 为 true 时，daemon 在每次 reconcile 时自动把 ymesh 扩展（MCP / skill / always-on）挂载到检测到的 CLI。设为 `false` 则要求显式 `ymesh mount all`。 |
| `daemon.device_id` | string | `os.hostname()` | 覆盖与每个 session 一起存储的设备标识 |
| `daemon.skip_cass` | boolean | `false` | 跳过 cass adapter（如 DB 缺失时有用） |
| `daemon.skip_claude` | boolean | `false` | 跳过 Claude 实时监听 |
| `daemon.skip_codex` | boolean | `false` | 跳过 Codex 实时监听 |

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YONDERMESH_HOME` | `~/.yondermesh` | 覆盖数据目录（DB、PID 文件、releases、briefings、密钥）。每次 CLI 调用都重新读取，可按 shell 设置。 |
| `--db <path>` | `<data-dir>/yondermesh.db` | CLI 参数（非环境变量）— 为单次命令覆盖 SQLite 路径。便于对副本做测试。 |
| `--json` | 关 | CLI 参数 — 输出 JSON 而非人类可读格式，便于脚本消费。 |

示例：使用临时数据目录运行。

```bash
YONDERMESH_HOME=/tmp/ymesh-test ymesh init
YONDERMESH_HOME=/tmp/ymesh-test ymesh daemon
```

示例：对副本 DB 做临时查询。

```bash
ymesh sessions --db /tmp/snapshot.db --json | jq '.[] | .id'
```

## 相关页面

- `/guide/daemon` — daemon 生命周期（scan -> watch -> reconcile -> idle）
- `/guide/sync` — relay 协议、密钥轮换、自建
- `/reference/files` — `~/.yondermesh/` 下的运行时布局
- `/reference/cli` — 全部 CLI 参数与命令
