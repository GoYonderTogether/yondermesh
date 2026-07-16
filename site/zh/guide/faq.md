---
title: 常见问题
description: yondermesh 常见问题 —— 隐私、范围、支持的 agent、同步与生命周期。
outline: [2, 3]
---

# 常见问题

yondermesh 的常见问题解答。回答内容均基于
[README](https://github.com/GoYonderTogether/yondermesh/blob/main/README.md)、
[ARCHITECTURE](https://github.com/GoYonderTogether/yondermesh/blob/main/ARCHITECTURE.md)
与 [SECURITY](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
三份文档。若遇到环境异常，请先看[故障排查](/zh/guide/troubleshooting)。

## 问：yondermesh 会把我的代码上传到云端吗？

不会。yondermesh 是**自托管、本地优先**的。所有 session 都存在本地
SQLite 文件 `~/.yondermesh/yondermesh.db` 里。离开你设备的只有发往跨设备
同步 relay 的**密文**，而这个 relay 是你自己运行的。即使你为了方便使用了
官方云 relay，它看到的也只是密文：E2E 加密密钥始终保存在你设备的
`~/.yondermesh/key.pem` 里，从不离开设备。

## 问：yondermesh 会接触我的 API key 吗？

不会。yondermesh 永远不代理模型调用。CLI agent（Claude Code、Codex、
Aider 等）直接用你自己的 API key 与模型厂商通信，yondermesh 只在事后读取
CLI 写下的 session 文件。"不做模型代理"是架构层面的硬约束 —— yondermesh
根本没有放置 API key 的位置。

## 问：我需要修改我的 CLI agent 吗？

不需要。yondermesh 直接读取原生 session 文件（JSONL、SQLite、git log
等），不做任何修改。[Mount 系统](/zh/guide/mount) 会把扩展（MCP server
注册、skill 符号链接、always-on 段落）安装到各 CLI **自己的配置目录**
（`~/.claude/`、`~/.codex/`、`~/.cursor/` 等），但绝不会去 patch CLI 二进制
本身或它的 session 写入逻辑。

## 问：支持哪些 CLI agent？

完整的支持矩阵见 [CLI 适配器](/zh/reference/adapters)。截至 v0.1.0，矩阵
里有 **22 个 A 级原生 importer**（直接读取 CLI 的原生 session 文件）和
**4 个 C 级 extractor**（部分覆盖，例如实时 transcript hook）。新 adapter
会持续增加 —— 矩阵在每次提交时由 `src/*/` 自动重新生成。

## 问：Windows 能用吗？

主要平台是 macOS 与 Linux。Windows 可以通过 WSL 使用：在 WSL 发行版里运行
daemon 与 CLI，并把 `devices[].agents[].path` 指向 WSL 文件系统路径。原生
Windows 支持在路线图上，但尚未发布。

## 问：有图形界面吗？

没有。yondermesh 由配置文件驱动，headless 运行。用户可感知的接口只有三个：

- **Daemon**（`ymesh daemon`）—— 后台运行，采集 session。
- **CLI**（`ymesh <command>`）—— 直接查询、挂载、handoff 等。
- **MCP server**（`ymesh mcp`）—— 给任意支持 MCP 的 agent 暴露查询工具。

你正在看的文档站是给人读的，不是用来操作 yondermesh 的。

## 问：跨设备同步是如何工作的？

端到端加密。每台设备都有自己的 `~/.yondermesh/key.pem`。同步 agent 从本地
`SessionStore` 读取新 session，用本地密钥加密后把密文推送到自托管 relay。
对端设备拉取密文后用自己的密钥解密。relay 只能看到密文、源/目的设备 id
以及消息大小，永远看不到 session 内容。配置细节见[跨设备同步](/zh/guide/sync)。

## 问：怎么把一个任务从一个 agent 交接给另一个 agent？

两种方式：

```bash
# 在 CLI 里：为一个 session 抽取浓缩的 handoff 包
ymesh handoff <session-id>
ymesh handoff <session-id> --json --tail 50
```

或者，在任意支持 MCP 的 agent 内部直接调用 `get_session_handoff` MCP 工具 —— 它
会返回相同的浓缩 handoff 包（摘要 + 最近的 tool call + plan）作为 JSON，
可直接注入给接收方 agent。

`ymesh handoff` 的参数见 [CLI 命令](/zh/reference/cli)，`get_session_handoff` 的
schema 见 [MCP 工具](/zh/reference/mcp-tools)。

## 问：怎么新增一个 CLI adapter？

新建 `src/<cli-name>/`，放一个 `importer.ts`，把该 CLI 的原生 session 格式
读进 `SessionStore`。然后在 `src/bin/ymesh.ts` 的 `cmdScan()` 里注册它，让
`ymesh scan` 能调用。最后运行 `npm run sync --prefix site` 重新生成 adapter
矩阵。完整流程（含测试与 doc-sync 检查）见[贡献指南](/zh/guide/contributing)
以及[适配器矩阵](/zh/reference/adapters)的"Adding a New Adapter"小节。

## 问：trae 与 trae-cn 有什么区别？

Trae 实际上有四个客户端变体：Trae IDE（国际版）、Trae IDE CN（中文版）、
Trae Work（国际版）、Trae Work CN（中文版）。ymesh 只用 **2 个 CliTarget**
就能覆盖全部 4 个变体 —— `~/.trae`（国际版）与 `~/.trae-cn`（中文版），
因为同一语种下 IDE 与 Work 共享同一个用户级 `skills/` 目录。完整挂载表见
[Mount 系统](/zh/guide/mount)。

## 问：怎么把 yondermesh 跑成后台服务？

macOS 上安装一个 LaunchAgent：

```bash
ymesh service install     # 安装 LaunchAgent plist
ymesh service start       # 开机自动启动 daemon
ymesh service status      # 查看是否在运行
```

`ymesh service stop` 用来停止，`ymesh service uninstall` 用来移除
LaunchAgent。Linux 上可以用 systemd 或你喜欢的进程管理工具包一层
`ymesh daemon`。详见 [Daemon](/zh/guide/daemon)。

## 问：怎么升级 yondermesh？

```bash
ymesh update              # 从 git 拉取、构建、安装，并原子地切换 symlink
ymesh rollback            # 出问题时回退到上一个 release
ymesh releases            # 列出所有已安装的 release
```

`ymesh update` 会原子地切换 symlink，若新版本启动失败会自动回滚。完整命令
列表见 [CLI 命令](/zh/reference/cli)。

## 问：我的数据存在哪里？

都在 `~/.yondermesh/` 下：

| 路径 | 用途 |
|---|---|
| `~/.yondermesh/yondermesh.db` | 本地 SQLite —— 所有已采集的 session |
| `~/.yondermesh/config.yaml` | devices、agents、sync relay、MCP、briefing 配置 |
| `~/.yondermesh/key.pem` | 跨设备同步的 E2E 加密密钥 |
| `~/.yondermesh/logs/` | daemon 与 CLI 日志 |
| `~/.yondermesh/releases/<version>/` | 已安装的 release |
| `~/.yondermesh/bin/ymesh` | 指向当前 release 的符号链接 |
| `~/.yondermesh/briefings/` | 每日 briefing 输出 |

完整目录树见[文件布局](/zh/reference/files)。

## 问：怎么完全重置 yondermesh？

```bash
ymesh service stop                # 先停掉 daemon（如果在运行）
mv ~/.yondermesh/yondermesh.db ~/.yondermesh/yondermesh.db.bak
ymesh scan                        # 从原生 session 文件重建数据库
```

这会从零重建本地 SQLite。relay 上的同步状态不受影响 —— 配对的设备会在下一
轮同步周期重新推送各自的 session。

## 问：有每日总结吗？

有。briefing 生成器会向 `~/.yondermesh/briefings/` 写入每日总结，汇总所有
设备上的 agent 活动（"你的 N 个 agent 跨 M 台设备今天完成了 K 个任务，成功
率 X%"）。在 `config.yaml` 里启用或关闭：

```yaml
briefing:
  enabled: true
  output: ~/.yondermesh/briefings
```

## 问：bug 应该报到哪里？

到
[github.com/GoYonderTogether/yondermesh/issues](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=bug&template=bug_report.md)
开 issue。如果是安全问题，请按
[SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
里的私有披露流程处理 —— **不要**为安全漏洞开公开 issue。

## 问：yondermesh 是什么协议？

MIT 协议，作者为 [未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether)。
欢迎贡献 —— 见[贡献指南](/zh/guide/contributing)。
