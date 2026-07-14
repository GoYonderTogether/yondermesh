# 健康状态参考

本文件定义 yondermesh 每个子系统在"正常运行"时应该呈现的状态。
诊断时将实际结果与本文对照即可快速判断偏差。

## 安装 (Install)

| 检查项 | 健康值 | 偏差含义 |
|---|---|---|
| `~/.yondermesh/` 目录 | 存在 | 不存在 = 未安装或 YONDERMESH_HOME 被覆盖 |
| `~/.yondermesh/bin/ymesh` | 有效符号链接指向 releases/current | 断开 = release 目录损坏或被删除 |
| `~/.yondermesh/releases/current` | 有效符号链接指向版本目录 | 不存在 = 从未执行 install 或安装失败 |
| `~/.yondermesh/releases/previous` | 有效符号链接 | 不存在 = 首次安装，无回退目标（可接受） |
| `ymesh` 在 PATH 中 | 是 | 否 = 需手动链接到 ~/.local/bin 或 PATH 配置缺失 |
| `YONDERMESH_HOME` 环境变量 | 未设置（使用默认）或指向自定义目录 | 意外设置可能导致数据分散 |

## 数据库 (Database)

| 检查项 | 健康值 | 偏差含义 |
|---|---|---|
| `~/.yondermesh/yondermesh.db` | 存在且非空 | 不存在 = 从未 scan 或路径错误 |
| `PRAGMA integrity_check` | `ok` | 其他值 = 数据库损坏 |
| 表数量 | 6 | 少于 6 = schema 不完整或版本过旧 |
| sessions 表行数 | > 0（扫描后） | 0 = 未扫描或扫描全部失败 |
| scan_runs 最新一条 | status=completed | 失败或不存在的 scan = 扫描器异常 |
| session_relationships 行数 | > 0（Claude/Codex 存在时） | 0 = adapter 未正确解析父子关系 |
| session_revisions 行数 | >= sessions 行数 | 小于 = 内容变更未被追踪 |

## 六张表及用途

| 表名 | 用途 |
|---|---|
| `source_instances` | 记录每个 CLI 来源实例（source + coverage + root_path） |
| `sessions` | 每个 session 的元数据（身份 = device_id + source_instance_id + native_session_id） |
| `session_revisions` | session 的内容版本，每次内容变更生成新 revision |
| `messages` | session 的消息列表（role + content + 时间戳） |
| `session_relationships` | session 间关系（spawned_by / sidechain_of / continued_from / import_alias_of / derived_from） |
| `scan_runs` | 每次扫描的运行记录（source_instance_id + started_at/ended_at + sessions_seen/new/updated） |

## Daemon

| 检查项 | 健康值 | 偏差含义 |
|---|---|---|
| `daemon.pid` 文件 | 存在，pid 进程活跃 | 文件存在但 pid 不活跃 = daemon 崩溃 |
| `daemon.pid` 文件 | 不存在 | 可能 daemon 未启动（检查是否 LaunchAgent 模式） |
| LaunchAgent plist | 存在于 ~/Library/LaunchAgents/ | 不存在 = 未执行 install 或仅手动运行 |
| `launchctl list | grep yondermesh` | 有输出 | 无输出 = plist 未 load 或被 unload |
| 日志最新修改时间 | 接近当前时间（daemon 运行中） | 很久未更新 = daemon 已停止 |

## 常见数据量参考（本机实测）

首次全量扫描后的典型数据量：

```
cass:      ~3,099 sessions, ~262K messages
claude:    ~1,141 sessions (219 root + 923 subagent)
codex:     ~131 sessions (含 18 个真实 subagent)
总计:      ~4,371 sessions, ~274K messages
```

如果实际数量显著偏低，可能是 adapter 未能发现部分文件或解析失败。
