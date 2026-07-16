---
title: 故障排查
description: 诊断并修复 yondermesh 的常见问题 —— daemon、MCP、sessions、同步、构建、升级、权限与 Trae skill 挂载。
outline: [2, 3]
---

# 故障排查

如果遇到问题，先跑一次 `ymesh doctor`。它会一次性检查安装状态、本地
SQLite 数据库、daemon 状态以及最近日志，通常能直接定位出问题的层。

```bash
ymesh doctor
```

关于 yondermesh 做什么、不做什么的背景，见[常见问题](/zh/guide/faq)。完整
命令参考见 [CLI 命令](/zh/reference/cli)。

## Daemon 不再扫描 session

**症状**：`ymesh sessions` 返回的结果与预期不符，或者新 session 没有进入
本地存储。

**处理**：

1. 检查 daemon 状态：

   ```bash
   ymesh status
   ```

   如果 daemon 没在跑，启动它（`ymesh daemon` 或 `ymesh service start`）。

2. 检查 `~/.yondermesh/config.yaml` 里 `devices[].agents[].path` 是否真的
  指向 CLI 写 session 的目录。常见路径：

   ```yaml
   devices:
     - name: macbook
       agents:
         - type: claude-code
           path: ~/.claude/projects
         - type: codex
           path: ~/.codex/sessions
   ```

3. 手动跑一次扫描，确认 importer 能找到文件：

   ```bash
   ymesh scan
   ```

   如果 `ymesh scan` 对某个 source 报告 0 条 session，说明路径错了，或 CLI
   还没往那里写过 session。

## 我的 agent 里看不到 MCP 工具

**症状**：agent 看不到 `search_sessions`、`list_active_sessions`、
`get_session_handoff` 等工具。

**处理**：

1. 检查 ymesh MCP 注册状态：

   ```bash
   ymesh mcp status
   ```

2. Claude Code 和 Codex 的注册是自动的：

   ```bash
   ymesh mcp register
   ```

   它会把 MCP server 配置写进 `~/.claude/...` 与 `~/.codex/config.toml`。

3. Cursor / Gemini / Windsurf 走的是 JSON 配置文件
   （`~/.cursor/mcp.json`、`~/.gemini/settings.json`、
   `~/.windsurf/mcp_config.json`）。运行 `ymesh mount all` 应用。

4. **Trae 的 MCP 必须通过 IDE UI 配置**，不是文件可挂。打开 Trae 的 MCP
   设置，手动添加 server：`command: ymesh`，`args: ["mcp"]`。

5. 重启 agent，让它重新读取配置。

## `ymesh sessions` 返回空

**症状**：`ymesh sessions` 没有任何输出，但你确信 session 是存在的。

**处理**：

1. 去掉所有过滤条件跑一次最宽的查询：

   ```bash
   ymesh sessions --limit 50
   ```

2. 检查 `--source` 是否写对了。规范 source ID 是小写的（`claude`、
   `codex`、`cass`、`hermes` …），不是 `ClaudeCode` 或 `claude-code`。CLI
   会做别名归一，但你传的值仍然要能解析到一个已知 source。

3. 检查目标 session 是不是 subagent。默认查询只返回 `root` 拓扑。试试：

   ```bash
   ymesh sessions --topology subagent
   ```

4. 检查 `--cwd-prefix`。它必须是 session `cwd` 的父目录。某些平台上尾部
   斜杠很关键。

5. 试试包含归档 session（被另一个 source 去重掉的）：

   ```bash
   ymesh sessions --include-archived
   ```

6. 确认数据库存在：

   ```bash
   ls -la ~/.yondermesh/yondermesh.db
   ```

   如果不存在，运行 `ymesh scan` 重建。

## 跨设备同步不工作

**症状**：设备 A 上的 session 在设备 B 上看不到。

**处理**：

1. 检查 `~/.yondermesh/config.yaml` 里的 `sync.relay_url`：

   ```yaml
   sync:
     relay_url: https://relay.your-domain.com
     key_file: ~/.yondermesh/key.pem
   ```

2. 确认**两台设备**都有 `~/.yondermesh/key.pem`。如果某台设备缺密钥，同步
   不会工作 —— 需要重新配对。

3. 确认 relay 可达：

   ```bash
   curl -I https://relay.your-domain.com
   ```

4. 翻日志找同步错误：

   ```bash
   ls -la ~/.yondermesh/logs/
   ```

5. 强制跑一次同步：

   ```bash
   ymesh state sync
   ```

完整架构见[跨设备同步](/zh/guide/sync)。

## 从源码构建失败

**症状**：`npm run build` 在 clone、install 或编译阶段报错。

**处理**：

1. 确认 Node.js 18+：

   ```bash
   node --version
   ```

2. 干净地安装依赖：

   ```bash
   rm -rf node_modules
   npm install
   ```

3. 重新构建并保留完整错误信息：

   ```bash
   npm run build 2>&1 | tee build.log
   ```

4. 单独跑 typecheck，区分类型错误与打包错误：

   ```bash
   npm run typecheck
   ```

如果是某个 adapter 的报错，见 [CLI 适配器](/zh/reference/adapters) 找到
对应源码目录。

## `ymesh update` 失败

**症状**：`ymesh update` 非零退出，或新的 `ymesh` 二进制启动失败。

**处理**：

1. 立刻回滚到上一个 release：

   ```bash
   ymesh rollback
   ```

2. 查日志找失败原因：

   ```bash
   ls -la ~/.yondermesh/logs/
   ```

3. 列出已安装的 release 确认回滚成功：

   ```bash
   ymesh releases
   ```

4. 如果 `ymesh update` 是 `--local` 构建，确认你的工作树能干净编译
   （`npm run build`）后再重试。

## 权限错误

**症状**：`ymesh` 报告文件不可读或路径不可写。

**处理**：

1. 检查数据目录归属：

   ```bash
   ls -la ~/.yondermesh/
   ```

   所有文件都应属于当前用户。如果 `sudo` 曾经动过这个目录，修复它：

   ```bash
   sudo chown -R $(whoami) ~/.yondermesh
   ```

2. 检查启动器符号链接：

   ```bash
   ls -la ~/.yondermesh/bin/ymesh
   ```

   它应指向 `~/.yondermesh/releases/<current-version>/ymesh`。如果目标
   不存在，用 `ymesh install` 重装。

3. 检查 CLI 自身配置目录是否有异常权限：

   ```bash
   ls -la ~/.claude/ ~/.codex/ ~/.cursor/
   ```

   ymesh mount 只会写到当前用户拥有的目录。

## Trae skills 没挂上

**症状**：`~/.trae/skills/ymesh-*` 符号链接缺失，或 Trae 的 skill 列表里
看不到 ymesh skill。

**处理**：

1. 确认目标 skill 目录存在：

   ```bash
   ls -la ~/.trae/skills/
   ls -la ~/.trae-cn/skills/
   ```

   缺失就建一下：

   ```bash
   mkdir -p ~/.trae/skills ~/.trae-cn/skills
   ```

2. 重新挂载：

   ```bash
   ymesh mount all
   ymesh mount status
   ```

3. Trae 用 2 个 `CliTarget`（`~/.trae` 与 `~/.trae-cn`）覆盖 4 个客户端
   变体（Trae IDE / Trae Work × 国际 / 中文）。如果只有某一个变体缺
   skill，重点查对应的 `~/.trae-cn/skills/` 目录。

4. **Trae 不支持 always-on 段落注入，也不支持文件挂 MCP**。ymesh 对 Trae
   只用 `skill-symlink` —— 不要期望出现 `AGENTS.md` 注入（不会发生）。
   Trae 的 MCP 请走 IDE UI 配置。

完整挂载策略表见 [Mount 系统](/zh/guide/mount)。

## 日志

所有日志都在 `~/.yondermesh/logs/` 下。daemon 写滚动日志；CLI 追加到单独
的文件。Tail daemon 日志可以实时看扫描/同步周期：

```bash
tail -f ~/.yondermesh/logs/daemon.log
```

## 数据库

本地 SQLite 数据库在 `~/.yondermesh/yondermesh.db`。它是磁盘上唯一不能从
CLI 原生 session 文件重建的持久状态。怀疑损坏时：

```bash
sqlite3 ~/.yondermesh/yondermesh.db "PRAGMA integrity_check;"
```

## 如何重置

想在保留配置与同步密钥的前提下从头开始：

```bash
ymesh service stop
mv ~/.yondermesh/yondermesh.db ~/.yondermesh/yondermesh.db.bak
ymesh scan
```

`ymesh scan` 会从每个 CLI 的原生 session 文件重新构建数据库。同步密钥
（`~/.yondermesh/key.pem`）与配置不受影响，跨设备配对会保留。

## 报告 bug

如果 `ymesh doctor` 和上面的步骤都没解决，到
[github.com/GoYonderTogether/yondermesh/issues](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=bug&template=bug_report.md)
开 bug report，附上：

- `ymesh doctor` 的输出。
- `~/.yondermesh/logs/` 里相关日志片段。
- 操作系统、Node.js 版本、yondermesh 版本（`ymesh version`）。
- 你执行的命令、期望行为、实际行为。

安全问题请按
[SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
里的私有披露流程处理 —— **不要**为安全漏洞开公开 issue。

## 相关

- [常见问题](/zh/guide/faq)
- [文件布局](/zh/reference/files)
- [CLI 命令](/zh/reference/cli)
- [Daemon](/zh/guide/daemon)
- [跨设备同步](/zh/guide/sync)
- [Mount 系统](/zh/guide/mount)
