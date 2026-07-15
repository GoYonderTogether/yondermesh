---
title: CLI 命令
description: ymesh CLI 完整命令参考。
outline: [2, 3]
---

> **自动生成** 自 `ymesh help`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。
> yondermesh 版本：`0.1.0`

## 用法

```bash
ymesh <command> [options]
ymesh <command> --json          # 以 JSON 输出，便于脚本消费
ymesh <command> --db <path>     # 指定数据库路径
```

## 命令

| 命令 | 说明 |
|---|---|
| `ymesh help` | 显示此帮助信息 |
| `ymesh version` | 显示版本号 |
| `ymesh scan` | 扫描本机全部 session（27 个 adapter：cass/claude/codex/hermes/ |
| `ymesh status` | 显示 daemon 状态和最近扫描结果 |
| `ymesh agents` | 列出本机检测到的所有 agent 及其支持状态 |
| `ymesh sessions` | 列出 session（支持过滤） |
| `ymesh daemon` | 启动后台 daemon（实时监听 + 定时 reconcile） |
| `ymesh 选项:` | --db &lt;path&gt; --data-dir &lt;dir&gt; --pid-file &lt;path&gt; |
| `ymesh install` | 本地构建 release 并安装 |
| `ymesh service` | &lt;action&gt;    管理 LaunchAgent (install|uninstall|start|stop|status) |
| `ymesh releases` | 列出已安装的 release 版本 |
| `ymesh update` | [--local]    从 Git 源码更新（构建失败自动回退）；--local 跳过 clone，从本地源码打包 |
| `ymesh rollback` | 手动回退到上一个 release 版本 |
| `ymesh mcp` | 启动 MCP server（stdio JSON-RPC，供其他 agent 挂载） |
| `ymesh mcp` | call &lt;tool&gt; [args]  终端直接调用 MCP 工具（如 ymesh mcp call who_is_working） |
| `ymesh mcp` | register        注册 MCP server 到 Claude Code 和 Codex（安装后新 session 自动可用） |
| `ymesh mcp` | unregister      从 Claude Code 和 Codex 注销 |
| `ymesh mcp` | status          查看 MCP 注册状态 |
| `ymesh active` | 快速查看当前正在运行的 session（谁在干活） |
| `ymesh doctor` | 运行系统诊断（检查安装、数据库、daemon、日志健康状态） |
| `ymesh mount` | [status|all|remove]  管理跨 CLI 挂载（MCP/Skill/Plugin 到所有已安装的 CLI agent） |
| `ymesh extract` | 提取项目全部 user 需求与 assistant 响应到 NDJSONL 文件（按行号/ID 索引） |
| `ymesh handoff` | &lt;id&gt;        提取 session 浓缩 handoff 包（compacted 摘要 + tool call + plan），用于任务接管 |
| `ymesh state` | &lt;action&gt;      管理运行时状态文件 (sync|show) |
| `ymesh mailbox` | &lt;action&gt;    文件系统跨 session 通信 (post|get|list) |
| `ymesh launch` | 启动新 agent session（--cli &lt;agent&gt; --prompt "text" [--model &lt;m&gt;]） |
| `ymesh inject` | 向运行中 session 注入消息（--cli &lt;agent&gt; --session &lt;id&gt; --message "text"） |
| `ymesh transfer` | 跨 agent 转交 session（--cli &lt;src&gt; --session &lt;id&gt; --target &lt;dst&gt; [--output &lt;path&gt;]） |

## 通用选项

| 参数 | 说明 |
|---|---|
| `--json` | 以 JSON 格式输出结果（便于脚本消费） |
| `--db` | &lt;path&gt;         指定数据库路径（默认 ~/.yondermesh/yondermesh.db） |

## 过滤选项

用于 `sessions`、`extract`、`handoff` 命令。

| 参数 | 说明 |
|---|---|
| `--limit` | &lt;n&gt;         限制输出条数（默认 20） |
| `--source` | &lt;name&gt;     按来源过滤（claude / codex / cass） |
| `--topology` | &lt;type&gt;   按拓扑过滤（root / subagent） |
| `--cwd` | &lt;path&gt;        按 cwd 精确匹配 |
| `--cwd-prefix` | &lt;path&gt; 按 cwd 前缀匹配（目录边界安全） |
| `--project` | &lt;path&gt;    按 projectPath 精确匹配 |
| `--from` | &lt;time&gt;       起始时间（epoch ms 或 ISO 日期） |
| `--to` | &lt;time&gt;         截止时间（epoch ms 或 ISO 日期） |
| `--include-archived` | 包含被去重的 session（默认不显示） |
| `--cwd-prefix` | &lt;path&gt;  项目目录前缀（默认当前 cwd） |
| `--project` | &lt;path&gt;     projectPath 精确匹配（与 --cwd-prefix 二选一） |
| `--from` | / --to        session 起始时间区间过滤 |
| `--requirements` | 查询需求文件（user 消息） |
| `--responses` | 查询响应文件（assistant 消息） |
| `--id` | &lt;n&gt;             按行号/ID 精确取一条（1-based） |
| `--keyword` | &lt;text&gt;     关键词模糊匹配（大小写不敏感） |
| `--session` | &lt;id&gt;       按 yondermesh session ID 过滤 |
| `--limit` | &lt;n&gt;          查询返回条数上限 |
| `--offset` | &lt;n&gt;         查询跳过前 N 条 |
| `--list` | 列出所有已提取过的项目 |
| `--json` | 以 JSON 格式输出 handoff 包 |
| `--tail` | &lt;n&gt;          尾部消息条数（默认 30） |

## 示例

```bash
ymesh scan
ymesh sessions --limit 50
ymesh sessions --source claude --topology root
ymesh sessions --cwd-prefix /Users/zoran/projects --json
ymesh status
ymesh daemon
ymesh extract --cwd-prefix /Users/zoran/projects/yondermesh
ymesh extract --requirements --id 3
ymesh handoff 019f5fe4-b127-7de2-b8f1-efa45bee24cb
ymesh handoff 019f5fe4-b127-7de2-b8f1-efa45bee24cb --json --tail 50
```
